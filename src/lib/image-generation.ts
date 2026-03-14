import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import {
  composeImageFromLayers,
  createObjectLayerFromSegmented,
  parseReferenceIntent,
  type ObjectLayer,
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
  const { data, error } = await supabase.functions.invoke("segment-object", {
    body: { image },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao segmentar objeto.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem segmentada retornada.");
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

  const segmentedUrl = await segmentObject(referenceImage);
  const newLayer = await createObjectLayerFromSegmented({
    segmentedImage: segmentedUrl,
    instruction,
    step: existingLayers[targetLayerIndex].createdStep,
    existingLayers: [],
    baseImage: compositionBaseImage,
  });

  // Preserve the original layer's position and size
  const oldLayer = existingLayers[targetLayerIndex];
  const replacedLayer: ObjectLayer = {
    ...newLayer,
    id: oldLayer.id,
    bbox: { ...oldLayer.bbox },
    anchor: oldLayer.anchor,
    createdStep: oldLayer.createdStep,
  };

  const layers = existingLayers.map((layer, i) => (i === targetLayerIndex ? replacedLayer : layer));
  const imageUrl = await composeImageFromLayers(compositionBaseImage, layers);

  return { imageUrl, layers, replacedLayer, compositionBaseImage };
}

/**
 * Smart handler: decides whether to replace or add based on instruction + existing layers.
 * Also handles the case where the target is baked into the base image (no tracked layer)
 * by falling back to AI refinement with explicit replace instructions.
 */
export async function handleReferenceImageEdit({
  compositionBaseImage,
  existingLayers,
  referenceImage,
  instruction,
  currentImage,
  llmProvider,
}: {
  compositionBaseImage: string | null;
  existingLayers: ObjectLayer[];
  referenceImage: string;
  instruction: string;
  currentImage: string;
  llmProvider?: LLMProvider;
}): Promise<{
  imageUrl: string;
  layers: ObjectLayer[];
  compositionBaseImage: string | null;
  action: "replaced_layer" | "added_layer" | "ai_replace";
  targetLabel?: string;
}> {
  const intentResult = parseReferenceIntent(instruction, existingLayers);

  // Case 1: Replace a tracked layer (deterministic canvas swap)
  if (
    intentResult.intent === "replace" &&
    intentResult.matchedLayerIndex >= 0 &&
    compositionBaseImage
  ) {
    const { imageUrl, layers, replacedLayer } = await replaceLayerInComposition({
      compositionBaseImage,
      existingLayers,
      referenceImage,
      instruction,
      targetLayerIndex: intentResult.matchedLayerIndex,
    });

    return {
      imageUrl,
      layers,
      compositionBaseImage,
      action: "replaced_layer",
      targetLabel: replacedLayer.label,
    };
  }

  // Case 2: Replace intent but no tracked layer → element is baked into base image → use AI
  if (intentResult.intent === "replace") {
    const { imageUrl } = await refineImageWithReplaceContext(
      currentImage,
      referenceImage,
      instruction,
      llmProvider
    );

    return {
      imageUrl,
      layers: [],
      compositionBaseImage: imageUrl,
      action: "ai_replace",
      targetLabel: intentResult.targetLabel,
    };
  }

  // Case 3: Add intent → append new layer
  if (!compositionBaseImage) {
    // No composition base, fall back to AI
    const { imageUrl } = await refineImage(currentImage, instruction, referenceImage, llmProvider);
    return {
      imageUrl,
      layers: [],
      compositionBaseImage: imageUrl,
      action: "ai_replace",
    };
  }

  const { imageUrl, layers, addedLayer } = await appendReferenceObjectToComposition({
    compositionBaseImage,
    existingLayers,
    referenceImage,
    instruction,
  });

  return {
    imageUrl,
    layers,
    compositionBaseImage,
    action: "added_layer",
    targetLabel: addedLayer.label,
  };
}

/**
 * AI refinement with explicit replace-mode system instructions.
 */
async function refineImageWithReplaceContext(
  currentImage: string,
  referenceImage: string,
  instruction: string,
  llmProvider?: LLMProvider
): Promise<{ imageUrl: string }> {
  const content: any[] = [
    { type: "image_url", image_url: { url: currentImage } },
    {
      type: "text",
      text: `MODO DE SUBSTITUIÇÃO ATIVADO. A imagem de referência a seguir contém o NOVO objeto que deve SUBSTITUIR o objeto existente mencionado na instrução. 

REGRAS DE SUBSTITUIÇÃO:
- IDENTIFIQUE o objeto alvo existente na cena (mencionado na instrução do usuário).
- SUBSTITUA esse objeto pelo novo objeto da referência, NA MESMA POSIÇÃO e com PROPORÇÕES SIMILARES.
- NÃO adicione um segundo objeto. O objeto antigo deve DESAPARECER e o novo deve ocupar seu lugar.
- NÃO coloque o novo objeto no primeiro plano / foreground.
- NÃO altere nenhum outro elemento da cena (bancos, vegetação, horizonte, gramado, etc.).
- PRESERVE o enquadramento, ângulo de câmera e composição geral.`,
    },
    { type: "image_url", image_url: { url: referenceImage } },
    { type: "text", text: instruction },
  ];

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: { content, llmProvider: llmProvider || "gemini" },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao substituir objeto.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");
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
