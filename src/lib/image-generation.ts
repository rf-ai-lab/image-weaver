import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import {
  composeImageFromLayers,
  createObjectLayerFromSegmented,
  parseReferenceIntent,
  resolveImageToDataUrl,
  type ObjectLayer,
  type ReferenceIntent,
} from "@/lib/object-composition";

export interface ReferenceImage {
  image: string;
  instruction: string;
}

export type ComposeImageParams = {
  baseImage: string;
  references: ReferenceImage[];
};

export type ComposeImageResult = {
  imageUrl: string;
  layers: ObjectLayer[];
  compositionBaseImage: string;
};

export type AppendReferenceObjectParams = {
  compositionBaseImage: string;
  existingLayers: ObjectLayer[];
  referenceImage: string;
  instruction: string;
};

export type AppendReferenceObjectResult = {
  imageUrl: string;
  layers: ObjectLayer[];
  addedLayer: ObjectLayer;
  compositionBaseImage: string;
};

export type ReplaceLayerParams = {
  compositionBaseImage: string;
  existingLayers: ObjectLayer[];
  referenceImage: string;
  instruction: string;
  targetLayerIndex: number;
};

export type ReplaceLayerResult = {
  imageUrl: string;
  layers: ObjectLayer[];
  replacedLayer: ObjectLayer;
  compositionBaseImage: string;
};

type FunctionInvokeError = {
  message?: string;
  context?: {
    status?: number;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  };
};

const DEBUG_PREFIX = "[ReferenceEditDebug]";
const NO_OP_DIFF_THRESHOLD = 0.0025;

export type ReferenceEditPath =
  | "replaceLayerInComposition"
  | "refineImageWithReplaceContext"
  | "appendReferenceObjectToComposition"
  | "refineImageFallback";

export interface ReferenceEditDebugInfo {
  instruction: string;
  detectedIntent: ReferenceIntent;
  targetLabel?: string;
  hasCompatibleLayer: boolean;
  matchedLayerIndex: number;
  executedPath: ReferenceEditPath;
  forceReplaceMode: boolean;
  inputBaseImageId: string;
  inputCurrentImageId: string;
  inputReferenceImageId: string;
  outputImageId: string;
  differenceRatio?: number;
  noOpDetected?: boolean;
}

function createStableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function toImageDebugId(image: string | null | undefined): string {
  if (!image) return "null";

  if (image.startsWith("data:")) {
    const headerEnd = image.indexOf(",");
    const header = headerEnd > -1 ? image.slice(0, headerEnd) : "data";
    const sample = image.slice(Math.max(0, image.length - 2048));
    return `data:${header};len=${image.length};hash=${createStableHash(sample)}`;
  }

  return `url:${image}`;
}

function logDebug(event: string, payload: unknown) {
  console.info(`${DEBUG_PREFIX} ${event}`, payload);
}

async function loadImageForDiff(source: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    if (!source.startsWith("data:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Falha ao carregar imagem para análise."));
    img.src = source;
  });
}

async function computeImageDifferenceRatio(beforeImage: string, afterImage: string): Promise<number> {
  const [beforeData, afterData] = await Promise.all([
    resolveImageToDataUrl(beforeImage),
    resolveImageToDataUrl(afterImage),
  ]);

  const [before, after] = await Promise.all([loadImageForDiff(beforeData), loadImageForDiff(afterData)]);

  const width = 96;
  const height = 96;

  const beforeCanvas = document.createElement("canvas");
  beforeCanvas.width = width;
  beforeCanvas.height = height;
  const beforeCtx = beforeCanvas.getContext("2d");

  const afterCanvas = document.createElement("canvas");
  afterCanvas.width = width;
  afterCanvas.height = height;
  const afterCtx = afterCanvas.getContext("2d");

  if (!beforeCtx || !afterCtx) {
    throw new Error("Não foi possível criar contexto de canvas para dif visual.");
  }

  beforeCtx.drawImage(before, 0, 0, width, height);
  afterCtx.drawImage(after, 0, 0, width, height);

  const beforePixels = beforeCtx.getImageData(0, 0, width, height).data;
  const afterPixels = afterCtx.getImageData(0, 0, width, height).data;

  let diffSum = 0;
  for (let i = 0; i < beforePixels.length; i += 4) {
    diffSum += Math.abs(beforePixels[i] - afterPixels[i]);
    diffSum += Math.abs(beforePixels[i + 1] - afterPixels[i + 1]);
    diffSum += Math.abs(beforePixels[i + 2] - afterPixels[i + 2]);
  }

  return diffSum / (width * height * 3 * 255);
}

async function detectNoOpEdit(beforeImage: string, afterImage: string): Promise<{ differenceRatio: number; noOp: boolean }> {
  const differenceRatio = await computeImageDifferenceRatio(beforeImage, afterImage);
  return {
    differenceRatio,
    noOp: differenceRatio <= NO_OP_DIFF_THRESHOLD,
  };
}

async function parseInvokeError(error: FunctionInvokeError): Promise<{ status?: number; message: string }> {
  const status = error?.context?.status;
  let message = error?.message || "Erro ao processar imagem.";

  if (typeof error?.context?.json === "function") {
    try {
      const body = (await error.context.json()) as { error?: string; message?: string };
      message = body?.error || body?.message || message;
      return { status, message };
    } catch {
      // ignore
    }
  }

  if (typeof error?.context?.text === "function") {
    try {
      const rawText = await error.context.text();
      if (rawText) message = rawText;
    } catch {
      // ignore
    }
  }

  return { status, message };
}

/**
 * Segment object from reference image using rembg (background removal).
 */
async function segmentObject(image: string): Promise<string> {
  logDebug("segmentObject:request", {
    referenceImageId: toImageDebugId(image),
  });

  const { data, error } = await supabase.functions.invoke("segment-object", {
    body: { image },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao segmentar objeto.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem segmentada retornada.");

  logDebug("segmentObject:response", {
    segmentedImageId: toImageDebugId(data.imageUrl),
  });

  return data.imageUrl;
}

/**
 * Main composition pipeline using deterministic visual composition.
 */
export async function composeImage({ baseImage, references }: ComposeImageParams): Promise<ComposeImageResult> {
  if (!baseImage) throw new Error("Imagem base é obrigatória.");
  if (!references || references.length === 0) throw new Error("Pelo menos uma imagem de referência é necessária.");

  const layers: ObjectLayer[] = [];

  for (const [index, ref] of references.entries()) {
    const segmentedUrl = await segmentObject(ref.image);
    const layer = await createObjectLayerFromSegmented({
      segmentedImage: segmentedUrl,
      instruction: ref.instruction,
      step: index + 1,
      existingLayers: layers,
      baseImage,
    });
    layers.push(layer);
  }

  const imageUrl = await composeImageFromLayers(baseImage, layers);

  return { imageUrl, layers, compositionBaseImage: baseImage };
}

/**
 * Add a new reference object into an existing composition stack.
 */
export async function appendReferenceObjectToComposition({
  compositionBaseImage,
  existingLayers,
  referenceImage,
  instruction,
}: AppendReferenceObjectParams): Promise<AppendReferenceObjectResult> {
  if (!compositionBaseImage) throw new Error("Imagem base da composição é obrigatória.");
  if (!referenceImage) throw new Error("Imagem de referência é obrigatória.");

  const segmentedUrl = await segmentObject(referenceImage);
  const addedLayer = await createObjectLayerFromSegmented({
    segmentedImage: segmentedUrl,
    instruction,
    step: existingLayers.length + 1,
    existingLayers,
    baseImage: compositionBaseImage,
  });

  const layers = [...existingLayers, addedLayer];
  const imageUrl = await composeImageFromLayers(compositionBaseImage, layers);

  logDebug("appendReferenceObjectToComposition", {
    instruction,
    compositionBaseImageId: toImageDebugId(compositionBaseImage),
    referenceImageId: toImageDebugId(referenceImage),
    outputImageId: toImageDebugId(imageUrl),
    addedLayerLabel: addedLayer.label,
    totalLayers: layers.length,
  });

  return { imageUrl, layers, addedLayer, compositionBaseImage };
}

/**
 * Replace an existing tracked layer with a new reference image,
 * keeping the same bbox position and anchor.
 */
export async function replaceLayerInComposition({
  compositionBaseImage,
  existingLayers,
  referenceImage,
  instruction,
  targetLayerIndex,
}: ReplaceLayerParams): Promise<ReplaceLayerResult> {
  if (!compositionBaseImage) throw new Error("Imagem base da composição é obrigatória.");
  if (!referenceImage) throw new Error("Imagem de referência é obrigatória.");
  if (targetLayerIndex < 0 || targetLayerIndex >= existingLayers.length) {
    throw new Error("Índice de camada alvo inválido.");
  }

  const oldLayer = existingLayers[targetLayerIndex];

  logDebug("replaceLayerInComposition:start", {
    instruction,
    targetLayerIndex,
    targetLayerLabel: oldLayer.label,
    compositionBaseImageId: toImageDebugId(compositionBaseImage),
    referenceImageId: toImageDebugId(referenceImage),
    oldLayerImageId: toImageDebugId(oldLayer.imageData),
  });

  const segmentedUrl = await segmentObject(referenceImage);
  const newLayer = await createObjectLayerFromSegmented({
    segmentedImage: segmentedUrl,
    instruction,
    step: existingLayers[targetLayerIndex].createdStep,
    existingLayers: [],
    baseImage: compositionBaseImage,
  });

  const replacedLayer: ObjectLayer = {
    ...newLayer,
    id: oldLayer.id,
    bbox: { ...oldLayer.bbox },
    anchor: oldLayer.anchor,
    createdStep: oldLayer.createdStep,
  };

  const layers = existingLayers.map((layer, i) => (i === targetLayerIndex ? replacedLayer : layer));

  const imageDataChanged = oldLayer.imageData !== replacedLayer.imageData;
  const renderLayerUsesUpdatedData = layers[targetLayerIndex].imageData === replacedLayer.imageData;

  const imageUrl = await composeImageFromLayers(compositionBaseImage, layers);

  logDebug("replaceLayerInComposition:done", {
    targetLayerIndex,
    targetLayerLabel: replacedLayer.label,
    imageDataChanged,
    renderLayerUsesUpdatedData,
    oldLayerImageId: toImageDebugId(oldLayer.imageData),
    replacedLayerImageId: toImageDebugId(replacedLayer.imageData),
    outputImageId: toImageDebugId(imageUrl),
  });

  return { imageUrl, layers, replacedLayer, compositionBaseImage };
}

/**
 * Smart handler para edição com imagem de referência.
 * Mantém parsing e logs de debug, mas prioriza novamente o fluxo via IA
 * para restaurar o comportamento anterior de edição sequencial.
 */
export async function handleReferenceImageEdit({
  compositionBaseImage,
  existingLayers,
  referenceImage,
  instruction,
  currentImage,
  llmProvider,
  forceReplaceMode = false,
}: {
  compositionBaseImage: string | null;
  existingLayers: ObjectLayer[];
  referenceImage: string;
  instruction: string;
  currentImage: string;
  llmProvider?: LLMProvider;
  forceReplaceMode?: boolean;
}): Promise<{
  imageUrl: string;
  layers: ObjectLayer[];
  compositionBaseImage: string | null;
  action: "replaced_layer" | "added_layer" | "ai_edit";
  targetLabel?: string;
  debug: ReferenceEditDebugInfo;
}> {
  const intentResult = parseReferenceIntent(instruction, existingLayers);
  const hasCompatibleLayer = intentResult.matchedLayerIndex >= 0;

  logDebug("handleReferenceImageEdit:start", {
    instruction,
    detectedIntent: intentResult.intent,
    targetLabel: intentResult.targetLabel,
    hasCompatibleLayer,
    matchedLayerIndex: intentResult.matchedLayerIndex,
    forceReplaceMode,
    currentImageId: toImageDebugId(currentImage),
    compositionBaseImageId: toImageDebugId(compositionBaseImage),
    referenceImageId: toImageDebugId(referenceImage),
    existingLayerLabels: existingLayers.map((layer) => layer.label),
  });

  let imageUrl = "";
  let executedPath: ReferenceEditPath = "refineImageFallback";
  let differenceRatio: number | undefined;
  let noOpDetected: boolean | undefined;

  if (intentResult.intent === "replace") {
    const firstPass = await refineImage(currentImage, instruction, referenceImage, llmProvider);
    imageUrl = firstPass.imageUrl;

    const firstDiff = await detectNoOpEdit(currentImage, imageUrl);
    differenceRatio = firstDiff.differenceRatio;
    noOpDetected = firstDiff.noOp;

    if (firstDiff.noOp) {
      logDebug("handleReferenceImageEdit:replaceNoOpRetry", {
        differenceRatio: firstDiff.differenceRatio,
        threshold: NO_OP_DIFF_THRESHOLD,
        path: "refineImageFallback",
      });

      const retry = await refineImageWithReplaceContext(
        currentImage,
        referenceImage,
        instruction,
        llmProvider,
        intentResult.targetLabel
      );

      imageUrl = retry.imageUrl;
      executedPath = "refineImageWithReplaceContext";

      const retryDiff = await detectNoOpEdit(currentImage, imageUrl);
      differenceRatio = retryDiff.differenceRatio;
      noOpDetected = retryDiff.noOp;
    }
  } else {
    const refined = await refineImage(currentImage, instruction, referenceImage, llmProvider);
    imageUrl = refined.imageUrl;
  }

  const debug: ReferenceEditDebugInfo = {
    instruction,
    detectedIntent: intentResult.intent,
    targetLabel: intentResult.targetLabel,
    hasCompatibleLayer,
    matchedLayerIndex: intentResult.matchedLayerIndex,
    executedPath,
    forceReplaceMode,
    inputBaseImageId: toImageDebugId(compositionBaseImage),
    inputCurrentImageId: toImageDebugId(currentImage),
    inputReferenceImageId: toImageDebugId(referenceImage),
    outputImageId: toImageDebugId(imageUrl),
    differenceRatio,
    noOpDetected,
  };

  logDebug("handleReferenceImageEdit:done", debug);

  return {
    imageUrl,
    layers: [],
    compositionBaseImage: imageUrl,
    action: "ai_edit",
    targetLabel: intentResult.targetLabel,
    debug,
  };
}

/**
 * AI refinement with explicit replace-mode system instructions.
 */
async function refineImageWithReplaceContext(
  currentImage: string,
  referenceImage: string,
  instruction: string,
  llmProvider?: LLMProvider,
  targetLabel?: string
): Promise<{ imageUrl: string }> {
  const replaceSystemPrompt = `MODO DE SUBSTITUIÇÃO ESTRITA ATIVADO.

OBJETIVO: substituir um objeto existente por outro da imagem de referência.
ALVO: ${targetLabel || "objeto citado na instrução"}.

PRIORIDADE ABSOLUTA:
- Se houver conflito entre "preservar" e "substituir", SUBSTITUIR vence.
- É proibido retornar imagem praticamente idêntica quando há pedido explícito de troca.

REGRAS:
1) IDENTIFIQUE o objeto alvo na imagem atual.
2) REMOVA o objeto antigo e substitua pelo objeto da referência.
3) MANTENHA a mesma região espacial, perspectiva e profundidade do alvo original.
4) NÃO crie duplicação (não pode existir segundo ${targetLabel || "objeto"}).
5) NÃO mover para foreground.
6) Preserve o restante da cena ao máximo, mas sem bloquear a substituição.`;

  const content: any[] = [
    { type: "image_url", image_url: { url: currentImage } },
    { type: "text", text: replaceSystemPrompt },
    { type: "image_url", image_url: { url: referenceImage } },
    { type: "text", text: instruction },
  ];

  logDebug("refineImageWithReplaceContext:request", {
    llmProvider: llmProvider || "gemini",
    targetLabel,
    currentImageId: toImageDebugId(currentImage),
    referenceImageId: toImageDebugId(referenceImage),
    textBlocks: content.filter((item) => item.type === "text").map((item) => item.text),
  });

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: { content, llmProvider: llmProvider || "gemini" },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao substituir objeto.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");

  logDebug("refineImageWithReplaceContext:response", {
    outputImageId: toImageDebugId(data.imageUrl),
  });

  return { imageUrl: data.imageUrl };
}

/**
 * AI fallback refinement for free-form edits not tied to tracked objects.
 */
export async function refineImage(
  currentImage: string,
  prompt: string,
  referenceImage?: string,
  llmProvider?: LLMProvider
): Promise<{ imageUrl: string }> {
  if (!currentImage) throw new Error("Imagem atual é obrigatória.");
  if (!prompt && !referenceImage) throw new Error("Prompt ou imagem de referência é obrigatório.");

  const content: any[] = [{ type: "image_url", image_url: { url: currentImage } }];

  if (referenceImage) {
    content.push({
      type: "text",
      text: "A imagem a seguir é uma REFERÊNCIA. Use-a conforme a instrução do usuário:",
    });
    content.push({
      type: "image_url",
      image_url: { url: referenceImage },
    });
  }

  if (prompt) {
    content.push({ type: "text", text: prompt });
  }

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: { content, llmProvider: llmProvider || "gemini" },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao refinar imagem.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");
  return { imageUrl: data.imageUrl };
}
