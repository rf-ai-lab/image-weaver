import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import {
  composeImageFromLayers,
  createObjectLayerFromSegmented,
  parseReferenceIntent,
  resolveImageToDataUrl,
  type NormalizedBBox,
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

/**
 * Set to true to draw red dashed outlines around cleanup regions in the final canvas.
 * Useful for visually validating which bbox area is being cleaned before recomposition.
 */
const DEBUG_VISUAL_CLEANUP = true;

export type ReferenceEditPath =
  | "replaceLayerInComposition"
  | "appendReferenceObjectToComposition"
  | "transformLayerInComposition"
  | "refineImageWithReplaceContext"
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

function mergeBBoxes(a: NormalizedBBox, b: NormalizedBBox): NormalizedBBox {
  const x1 = Math.max(0, Math.min(1, Math.min(a.x, b.x)));
  const y1 = Math.max(0, Math.min(1, Math.min(a.y, b.y)));
  const x2 = Math.max(0, Math.min(1, Math.max(a.x + a.width, b.x + b.width)));
  const y2 = Math.max(0, Math.min(1, Math.max(a.y + a.height, b.y + b.height)));

  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
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

  const imageUrl = await composeImageFromLayers(baseImage, layers, {
    compositionMode: "overlay_simple",
    debugSource: "composeImage",
  });

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
  const imageUrl = await composeImageFromLayers(compositionBaseImage, layers, {
    compositionMode: "overlay_simple",
    debugSource: "appendReferenceObjectToComposition",
  });

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
  const cleanupRegion = { ...oldLayer.bbox };

  const imageUrl = await composeImageFromLayers(compositionBaseImage, layers, {
    compositionMode: "replace_real",
    cleanupRegions: [cleanupRegion],
    debugSource: "replaceLayerInComposition",
    debugVisualCleanup: DEBUG_VISUAL_CLEANUP,
  });

  logDebug("replaceLayerInComposition:done", {
    targetLayerIndex,
    targetLayerLabel: replacedLayer.label,
    compositionMode: "replace_real",
    cleanupRegion,
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
 * FLUXO PRINCIPAL: composição por layers (append/replace/transform).
 * FALLBACK: IA (refineImage / refineImageWithReplaceContext) somente quando
 * não há composição rastreada ou layer compatível.
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
  action: "replaced_layer" | "added_layer" | "transformed_layer" | "ai_fallback";
  targetLabel?: string;
  debug: ReferenceEditDebugInfo;
}> {
  const effectiveRequestId = requestId || createImageEditRequestId();
  const intentResult = parseReferenceIntent(instruction, existingLayers);
  const hasCompatibleLayer = intentResult.matchedLayerIndex >= 0;
  const hasTrackedComposition = Boolean(compositionBaseImage) && existingLayers.length > 0;
  const inputTrace = createImageTraceSnapshot(currentImage);

  logDebug("handleReferenceImageEdit:start", {
    requestId: effectiveRequestId,
    instruction,
    detectedIntent: intentResult.intent,
    targetLabel: intentResult.targetLabel,
    hasCompatibleLayer,
    hasTrackedComposition,
    matchedLayerIndex: intentResult.matchedLayerIndex,
    forceReplaceMode,
    inputImageHash: inputTrace.hash,
    inputImageLength: inputTrace.length,
    currentImageId: toImageDebugId(currentImage),
    compositionBaseImageId: toImageDebugId(compositionBaseImage),
    referenceImageId: toImageDebugId(referenceImage),
    existingLayerLabels: existingLayers.map((layer) => layer.label),
  });

  // ─── PATH 1: LAYER-BASED REPLACE (primary when tracked composition + compatible layer) ───
  if (
    (intentResult.intent === "replace" || forceReplaceMode) &&
    hasCompatibleLayer &&
    hasTrackedComposition
  ) {
    logDebug("handleReferenceImageEdit:path", {
      requestId: effectiveRequestId,
      branch: "replaceLayerInComposition",
    });

    const result = await replaceLayerInComposition({
      compositionBaseImage: compositionBaseImage!,
      existingLayers,
      referenceImage,
      instruction,
      targetLayerIndex: intentResult.matchedLayerIndex,
    });

    const outputTrace = createImageTraceSnapshot(result.imageUrl);
    const debug = buildDebugInfo({
      effectiveRequestId, instruction, intentResult, hasCompatibleLayer,
      forceReplaceMode, inputTrace, compositionBaseImage, referenceImage,
      outputTrace, executedPath: "replaceLayerInComposition",
    });

    logDebug("handleReferenceImageEdit:done", debugSummary(debug));

    return {
      imageUrl: result.imageUrl,
      layers: result.layers,
      compositionBaseImage: result.compositionBaseImage,
      action: "replaced_layer",
      targetLabel: intentResult.targetLabel || result.replacedLayer.label,
      debug,
    };
  }

  // ─── PATH 2: LAYER-BASED ADD (primary when intent=add and tracked composition) ───
  if (intentResult.intent === "add" && hasTrackedComposition) {
    logDebug("handleReferenceImageEdit:path", {
      requestId: effectiveRequestId,
      branch: "appendReferenceObjectToComposition",
    });

    const result = await appendReferenceObjectToComposition({
      compositionBaseImage: compositionBaseImage!,
      existingLayers,
      referenceImage,
      instruction,
    });

    const outputTrace = createImageTraceSnapshot(result.imageUrl);
    const debug = buildDebugInfo({
      effectiveRequestId, instruction, intentResult, hasCompatibleLayer,
      forceReplaceMode, inputTrace, compositionBaseImage, referenceImage,
      outputTrace, executedPath: "appendReferenceObjectToComposition",
    });

    logDebug("handleReferenceImageEdit:done", debugSummary(debug));

    return {
      imageUrl: result.imageUrl,
      layers: result.layers,
      compositionBaseImage: result.compositionBaseImage,
      action: "added_layer",
      targetLabel: intentResult.targetLabel || result.addedLayer.label,
      debug,
    };
  }

  // ─── PATH 3: LAYER-BASED TRANSFORM (resize/move via parseObjectTransformPrompt) ───
  if (intentResult.intent === "transform" && hasCompatibleLayer && hasTrackedComposition) {
    logDebug("handleReferenceImageEdit:path", {
      requestId: effectiveRequestId,
      branch: "transformLayerInComposition",
    });

    const { parseObjectTransformPrompt, applyObjectTransformCommand, composeImageFromLayers: recompose } = await import("@/lib/object-composition");
    const command = parseObjectTransformPrompt(instruction, existingLayers);

    if (command) {
      const oldBBox = { ...existingLayers[intentResult.matchedLayerIndex].bbox };
      const { layers: updatedLayers } = applyObjectTransformCommand(existingLayers, command);
      const newBBox = { ...updatedLayers[intentResult.matchedLayerIndex].bbox };
      const cleanupRegion = mergeBBoxes(oldBBox, newBBox);

      logDebug("transformLayerInComposition:bboxUpdate", {
        requestId: effectiveRequestId,
        targetLayerIndex: intentResult.matchedLayerIndex,
        targetLabel: intentResult.targetLabel,
        oldBBox,
        newBBox,
        cleanupRegion,
      });

      const imageUrl = await recompose(compositionBaseImage!, updatedLayers, {
        compositionMode: "replace_real",
        cleanupRegions: [cleanupRegion],
        debugSource: "transformLayerInComposition",
        debugVisualCleanup: DEBUG_VISUAL_CLEANUP,
      });

      const outputTrace = createImageTraceSnapshot(imageUrl);
      const debug = buildDebugInfo({
        effectiveRequestId, instruction, intentResult, hasCompatibleLayer,
        forceReplaceMode, inputTrace, compositionBaseImage, referenceImage,
        outputTrace, executedPath: "transformLayerInComposition",
      });

      logDebug("handleReferenceImageEdit:done", debugSummary(debug));

      return {
        imageUrl,
        layers: updatedLayers,
        compositionBaseImage: compositionBaseImage!,
        action: "transformed_layer",
        targetLabel: intentResult.targetLabel,
        debug,
      };
    }
    // If parseObjectTransformPrompt returned null, fall through to AI fallback
  }

  // ─── PATH 4: AI FALLBACK (no tracked composition, no compatible layer, or unrecognized transform) ───
  logDebug("handleReferenceImageEdit:path", {
    requestId: effectiveRequestId,
    branch: "ai_fallback",
    reason: !hasTrackedComposition
      ? "no_tracked_composition"
      : !hasCompatibleLayer
      ? "no_compatible_layer"
      : "unrecognized_transform",
  });

  let imageUrl = "";
  let executedPath: ReferenceEditPath = "refineImageFallback";

  if (intentResult.intent === "replace") {
    // Try replace-context first for better results
    const result = await refineImageWithReplaceContext(
      currentImage,
      referenceImage,
      instruction,
      llmProvider,
      intentResult.targetLabel,
      effectiveRequestId
    );
    imageUrl = result.imageUrl;
    executedPath = "refineImageWithReplaceContext";
  } else {
    const result = await refineImage(currentImage, instruction, referenceImage, llmProvider, {
      requestId: effectiveRequestId,
      operation: "ai_fallback",
    });
    imageUrl = result.imageUrl;
    executedPath = "refineImageFallback";
  }

  // No-op detection for AI fallback
  const diagnostics = await detectNoOpEdit(currentImage, imageUrl);
  if (diagnostics.noOpDetected) {
    logDebug("handleReferenceImageEdit:noOpDetected", {
      requestId: effectiveRequestId,
      branchExecutado: executedPath,
      inputImageHash: diagnostics.input.hash,
      outputImageHash: diagnostics.output.hash,
      differenceRatio: diagnostics.differenceRatio,
    });
    throw new Error("edição não executada: saída idêntica à entrada");
  }

  const outputTrace = diagnostics.output;
  const debug = buildDebugInfo({
    effectiveRequestId, instruction, intentResult, hasCompatibleLayer,
    forceReplaceMode, inputTrace, compositionBaseImage, referenceImage,
    outputTrace, executedPath, differenceRatio: diagnostics.differenceRatio,
    noOpDetected: diagnostics.noOpDetected,
  });

  logDebug("handleReferenceImageEdit:done", debugSummary(debug));

  // AI fallback: preserve existing layers, don't zero them out
  return {
    imageUrl,
    layers: existingLayers,
    compositionBaseImage: compositionBaseImage || imageUrl,
    action: "ai_fallback",
    targetLabel: intentResult.targetLabel,
    debug,
  };
}

function buildDebugInfo({
  effectiveRequestId, instruction, intentResult, hasCompatibleLayer,
  forceReplaceMode, inputTrace, compositionBaseImage, referenceImage,
  outputTrace, executedPath, differenceRatio, noOpDetected,
}: {
  effectiveRequestId: string;
  instruction: string;
  intentResult: { intent: ReferenceIntent; targetLabel?: string; matchedLayerIndex: number };
  hasCompatibleLayer: boolean;
  forceReplaceMode: boolean;
  inputTrace: ImageTraceSnapshot;
  compositionBaseImage: string | null;
  referenceImage: string;
  outputTrace: ImageTraceSnapshot;
  executedPath: ReferenceEditPath;
  differenceRatio?: number;
  noOpDetected?: boolean;
}): ReferenceEditDebugInfo {
  return {
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
    differenceRatio,
    noOpDetected,
  };
}

function debugSummary(debug: ReferenceEditDebugInfo): Record<string, unknown> {
  return {
    requestId: debug.requestId,
    detectedIntent: debug.detectedIntent,
    targetLabel: debug.targetLabel,
    branchExecutado: debug.executedPath,
    inputImageHash: debug.inputImageHash,
    outputImageHash: debug.outputImageHash,
    differenceRatio: debug.differenceRatio,
    noOpDetected: debug.noOpDetected,
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
  llmProvider?: LLMProvider,
  trace?: EditInvokeTraceOptions
): Promise<{ imageUrl: string }> {
  if (!currentImage) throw new Error("Imagem atual é obrigatória.");
  if (!prompt && !referenceImage) throw new Error("Prompt ou imagem de referência é obrigatório.");

  const requestId = trace?.requestId || createImageEditRequestId();
  const operation = trace?.operation || "refine:default";

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

  const currentTrace = createImageTraceSnapshot(currentImage);
  const referenceTrace = createImageTraceSnapshot(referenceImage);

  logDebug("refineImage:request", {
    requestId,
    operation,
    llmProvider: llmProvider || "gemini",
    currentImageHash: currentTrace.hash,
    currentImageLength: currentTrace.length,
    currentImagePreview: currentTrace.preview,
    referenceImageHash: referenceTrace.hash,
    referenceImageLength: referenceTrace.length,
    referenceImagePreview: referenceTrace.preview,
    textBlocks: content.filter((item) => item.type === "text").map((item) => item.text),
  });

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: {
      content,
      llmProvider: llmProvider || "gemini",
      requestId,
      operation,
      inputImageHash: currentTrace.hash,
      referenceImageHash: referenceTrace.hash,
    },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao refinar imagem.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");

  const outputTrace = createImageTraceSnapshot(data.imageUrl);
  logDebug("refineImage:response", {
    requestId,
    operation,
    outputImageHash: outputTrace.hash,
    outputImageLength: outputTrace.length,
    outputImagePreview: outputTrace.preview,
    outputImageId: outputTrace.identifier,
  });

  return { imageUrl: data.imageUrl };
}
