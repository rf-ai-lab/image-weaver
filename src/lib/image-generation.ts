import { supabase } from "@/integrations/supabase/client";

export interface ReferenceImage {
  image: string;
  instruction: string;
}

export type ComposeImageParams = {
  baseImage: string;
  references: ReferenceImage[];
  model?: string;
};

export type ComposeImageResult = {
  imageUrl: string;
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
 * Step 1: Segment object from reference image using rembg (background removal).
 * Returns a URL to the PNG with transparent background.
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
 * Step 2: Compose segmented objects onto the base image using Gemini vision.
 * Sends the base image + all segmented reference PNGs + instructions to the AI.
 */
async function composeWithAI(baseImage: string, segmentedRefs: { segmentedUrl: string; instruction: string }[], model?: string): Promise<string> {
  const content: any[] = [
    { type: "text", text: "Esta é a IMAGEM BASE (cena principal). Preserve-a integralmente." },
    { type: "image_url", image_url: { url: baseImage } },
  ];

  for (let i = 0; i < segmentedRefs.length; i++) {
    const ref = segmentedRefs[i];
    content.push({
      type: "text",
      text: `REFERÊNCIA ${i + 1}: ${ref.instruction}`,
    });
    content.push({
      type: "image_url",
      image_url: { url: ref.segmentedUrl },
    });
  }

  content.push({
    type: "text",
    text: "Componha a imagem final: insira APENAS os objetos das referências sobre a imagem base, respeitando perspectiva, escala e iluminação. NÃO altere nada da cena base que não foi mencionado.",
  });

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: { content, model },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao compor imagem.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem composta retornada.");
  return data.imageUrl;
}

/**
 * Main composition pipeline:
 * 1. For each reference image → segment object (remove background)
 * 2. Send base image + all segmented objects + instructions to Gemini for composition
 * 3. Return the final composed image
 */
export async function composeImage({ baseImage, references, model }: ComposeImageParams): Promise<ComposeImageResult> {
  if (!baseImage) throw new Error("Imagem base é obrigatória.");
  if (!references || references.length === 0) throw new Error("Pelo menos uma imagem de referência é necessária.");

  const segmentationResults = await Promise.all(
    references.map(async (ref) => {
      const segmentedUrl = await segmentObject(ref.image);
      return { segmentedUrl, instruction: ref.instruction };
    })
  );

  const imageUrl = await composeWithAI(baseImage, segmentationResults, model);
  return { imageUrl };
}

/**
 * Simple refinement: send the current image + prompt to Gemini for text-based edits
 * (e.g., "change flower color to red", "remove the left arrangement")
 */
export async function refineImage(currentImage: string, prompt: string, referenceImage?: string, model?: string): Promise<ComposeImageResult> {
  if (!currentImage) throw new Error("Imagem atual é obrigatória.");
  if (!prompt) throw new Error("Prompt é obrigatório.");

  const content: any[] = [
    { type: "image_url", image_url: { url: currentImage } },
  ];

  if (referenceImage) {
    content.push({ type: "text", text: "IMAGEM DE REFERÊNCIA anexada pelo usuário:" });
    content.push({ type: "image_url", image_url: { url: referenceImage } });
  }

  content.push({ type: "text", text: prompt });

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: { content, model },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao refinar imagem.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");
  return { imageUrl: data.imageUrl };
}
