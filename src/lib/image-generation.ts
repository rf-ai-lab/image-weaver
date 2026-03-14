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

interface ImageTraceSnapshot {
  hash: string;
  length: number;
  preview: string;
  identifier: string;
}

interface NoOpDiagnostics {
  input: ImageTraceSnapshot;
  output: ImageTraceSnapshot;
  sameUrl: boolean;
  sameHash: boolean;
  sameLength: boolean;
  differenceRatio: number;
  noOpDetected: boolean;
}

export interface ReferenceEditDebugInfo {
  requestId: string;
  timestamp: string;
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
  inputImageHash: string;
  outputImageHash: string;
  inputImageLength: number;
  outputImageLength: number;
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

function buildImagePreview(value: string): string {
  if (!value) return "";
  if (value.length <= 48) return value;
  return `${value.slice(0, 24)}...${value.slice(-24)}`;
}

function createImageTraceSnapshot(image: string | null | undefined): ImageTraceSnapshot {
  if (!image) {
    return {
      hash: "null",
      length: 0,
      preview: "null",
      identifier: "null",
    };
  }

  const sample = image.startsWith("data:") ? image.slice(Math.max(0, image.length - 4096)) : image;
  const hash = createStableHash(sample);
  const identifier = image.startsWith("data:")
    ? `data:${image.slice(0, Math.min(32, image.length))};len=${image.length};hash=${hash}`
    : `url:${buildImagePreview(image)};len=${image.length};hash=${hash}`;

  return {
    hash,
    length: image.length,
    preview: buildImagePreview(image),
    identifier,
  };
}

function toImageDebugId(image: string | null | undefined): string {
  return createImageTraceSnapshot(image).identifier;
}

export function createImageEditRequestId(): string {
  return crypto.randomUUID();
}

function logDebug(event: string, payload: Record<string, unknown>) {
  console.info(`${DEBUG_PREFIX} ${event}`, {
    timestamp: new Date().toISOString(),
    ...payload,
  });
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

async function detectNoOpEdit(beforeImage: string, afterImage: string): Promise<NoOpDiagnostics> {
  const [differenceRatio, input, output] = await Promise.all([
    computeImageDifferenceRatio(beforeImage, afterImage),
    Promise.resolve(createImageTraceSnapshot(beforeImage)),
    Promise.resolve(createImageTraceSnapshot(afterImage)),
  ]);

  const sameUrl = beforeImage === afterImage;
  const sameHash = input.hash === output.hash;
  const sameLength = input.length === output.length;
  const noOpDetected = sameUrl || (sameHash && sameLength) || differenceRatio <= NO_OP_DIFF_THRESHOLD;

  return {
    input,
    output,
    sameUrl,
    sameHash,
    sameLength,
    differenceRatio,
    noOpDetected,
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
  requestId,
}: {
  compositionBaseImage: string | null;
  existingLayers: ObjectLayer[];
  referenceImage: string;
  instruction: string;
  currentImage: string;
  llmProvider?: LLMProvider;
  forceReplaceMode?: boolean;
  requestId?: string;
}): Promise<{
  imageUrl: string;
  layers: ObjectLayer[];
  compositionBaseImage: string | null;
  action: "replaced_layer" | "added_layer" | "ai_edit";
  targetLabel?: string;
  debug: ReferenceEditDebugInfo;
}> {
  const effectiveRequestId = requestId || createImageEditRequestId();
  const intentResult = parseReferenceIntent(instruction, existingLayers);
  const hasCompatibleLayer = intentResult.matchedLayerIndex >= 0;
  const inputTrace = createImageTraceSnapshot(currentImage);

  logDebug("handleReferenceImageEdit:start", {
    requestId: effectiveRequestId,
    instruction,
    detectedIntent: intentResult.intent,
    targetLabel: intentResult.targetLabel,
    hasCompatibleLayer,
    matchedLayerIndex: intentResult.matchedLayerIndex,
    forceReplaceMode,
    inputImageHash: inputTrace.hash,
    inputImageLength: inputTrace.length,
    inputImagePreview: inputTrace.preview,
    currentImageId: toImageDebugId(currentImage),
    compositionBaseImageId: toImageDebugId(compositionBaseImage),
    referenceImageId: toImageDebugId(referenceImage),
    existingLayerLabels: existingLayers.map((layer) => layer.label),
  });

  let imageUrl = "";
  let executedPath: ReferenceEditPath = "refineImageFallback";
  let diagnostics: NoOpDiagnostics | null = null;

  if (intentResult.intent === "replace") {
    const firstPass = await refineImage(currentImage, instruction, referenceImage, llmProvider, {
      requestId: effectiveRequestId,
      operation: "replace:first_pass",
    });
    imageUrl = firstPass.imageUrl;
    diagnostics = await detectNoOpEdit(currentImage, imageUrl);

    if (diagnostics.noOpDetected) {
      logDebug("handleReferenceImageEdit:replaceNoOpRetry", {
        requestId: effectiveRequestId,
        branchExecutado: executedPath,
        inputImageHash: diagnostics.input.hash,
        outputImageHash: diagnostics.output.hash,
        sameUrl: diagnostics.sameUrl,
        sameHash: diagnostics.sameHash,
        sameLength: diagnostics.sameLength,
        differenceRatio: diagnostics.differenceRatio,
        threshold: NO_OP_DIFF_THRESHOLD,
      });

      const retry = await refineImageWithReplaceContext(
        currentImage,
        referenceImage,
        instruction,
        llmProvider,
        intentResult.targetLabel,
        effectiveRequestId
      );

      imageUrl = retry.imageUrl;
      executedPath = "refineImageWithReplaceContext";
      diagnostics = await detectNoOpEdit(currentImage, imageUrl);
    }
  } else {
    const refined = await refineImage(currentImage, instruction, referenceImage, llmProvider, {
      requestId: effectiveRequestId,
      operation: "add_or_transform",
    });
    imageUrl = refined.imageUrl;
    diagnostics = await detectNoOpEdit(currentImage, imageUrl);
  }

  if (!diagnostics) {
    diagnostics = await detectNoOpEdit(currentImage, imageUrl);
  }

  if (diagnostics.noOpDetected) {
    logDebug("handleReferenceImageEdit:noOpDetected", {
      requestId: effectiveRequestId,
      branchExecutado: executedPath,
      detectedIntent: intentResult.intent,
      targetLabel: intentResult.targetLabel,
      inputImageHash: diagnostics.input.hash,
      outputImageHash: diagnostics.output.hash,
      inputImageLength: diagnostics.input.length,
      outputImageLength: diagnostics.output.length,
      inputImagePreview: diagnostics.input.preview,
      outputImagePreview: diagnostics.output.preview,
      sameUrl: diagnostics.sameUrl,
      sameHash: diagnostics.sameHash,
      sameLength: diagnostics.sameLength,
      differenceRatio: diagnostics.differenceRatio,
      noOpDetected: diagnostics.noOpDetected,
    });

    throw new Error("edição não executada: saída idêntica à entrada");
  }

  const outputTrace = diagnostics.output;
  const debug: ReferenceEditDebugInfo = {
    requestId: effectiveRequestId,
    timestamp: new Date().toISOString(),
    instruction,
    detectedIntent: intentResult.intent,
    targetLabel: intentResult.targetLabel,
    hasCompatibleLayer,
    matchedLayerIndex: intentResult.matchedLayerIndex,
    executedPath,
    forceReplaceMode,
    inputBaseImageId: toImageDebugId(compositionBaseImage),
    inputCurrentImageId: inputTrace.identifier,
    inputReferenceImageId: toImageDebugId(referenceImage),
    outputImageId: outputTrace.identifier,
    inputImageHash: inputTrace.hash,
    outputImageHash: outputTrace.hash,
    inputImageLength: inputTrace.length,
    outputImageLength: outputTrace.length,
    differenceRatio: diagnostics.differenceRatio,
    noOpDetected: diagnostics.noOpDetected,
  };

  logDebug("handleReferenceImageEdit:done", {
    requestId: debug.requestId,
    detectedIntent: debug.detectedIntent,
    targetLabel: debug.targetLabel,
    branchExecutado: debug.executedPath,
    inputImageHash: debug.inputImageHash,
    outputImageHash: debug.outputImageHash,
    differenceRatio: debug.differenceRatio,
    noOpDetected: debug.noOpDetected,
  });

  return {
    imageUrl,
    layers: [],
    compositionBaseImage: imageUrl,
    action: "ai_edit",
    targetLabel: intentResult.targetLabel,
    debug,
  };
}

type EditInvokeTraceOptions = {
  requestId: string;
  operation: string;
};

/**
 * AI refinement with explicit replace-mode system instructions.
 */
async function refineImageWithReplaceContext(
  currentImage: string,
  referenceImage: string,
  instruction: string,
  llmProvider: LLMProvider | undefined,
  targetLabel: string | undefined,
  requestId: string
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
    requestId,
    operation: "replace:retry_context",
    llmProvider: llmProvider || "gemini",
    targetLabel,
    currentImageId: toImageDebugId(currentImage),
    referenceImageId: toImageDebugId(referenceImage),
    textBlocks: content.filter((item) => item.type === "text").map((item) => item.text),
  });

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: {
      content,
      llmProvider: llmProvider || "gemini",
      requestId,
      operation: "replace:retry_context",
      inputImageHash: createImageTraceSnapshot(currentImage).hash,
      referenceImageHash: createImageTraceSnapshot(referenceImage).hash,
    },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao substituir objeto.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");

  logDebug("refineImageWithReplaceContext:response", {
    requestId,
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
