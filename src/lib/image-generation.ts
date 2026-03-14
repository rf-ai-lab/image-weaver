import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import {
  composeImageFromLayers,
  createObjectLayerFromSegmented,
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
 * Keeps base scene fixed and inserts segmented objects as layers.
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

  return {
    imageUrl,
    layers,
    compositionBaseImage: baseImage,
  };
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

  return {
    imageUrl,
    layers,
    addedLayer,
    compositionBaseImage,
  };
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
