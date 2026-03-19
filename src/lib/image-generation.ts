import { supabase } from "@/integrations/supabase/client";
import type { ObjectLayer } from "@/lib/object-composition";

export function createImageEditRequestId(): string {
  return crypto.randomUUID();
}

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
    } catch { /* ignore */ }
  }
  if (typeof error?.context?.text === "function") {
    try {
      const rawText = await error.context.text();
      if (rawText) message = rawText;
    } catch { /* ignore */ }
  }
  return { status, message };
}

export async function refineImage(
  currentImage: string,
  prompt: string,
  referenceImage?: string,
  llmProvider?: string,
): Promise<{ imageUrl: string }> {
  const { data, error } = await supabase.functions.invoke("generate-decoration", {
    body: {
      image: currentImage,
      prompt,
      llm_provider: llmProvider || "openai",
    },
  });

  if (error) {
    const parsed = await parseInvokeError(error as FunctionInvokeError);
    throw new Error(parsed.message || "Erro ao gerar imagem.");
  }

  if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");
  return { imageUrl: data.imageUrl };
}

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
  llmProvider?: string;
  forceReplaceMode?: boolean;
  requestId?: string;
}): Promise<{
  imageUrl: string;
  layers: ObjectLayer[];
  compositionBaseImage: string | null;
  action: "replaced_layer" | "added_layer" | "transformed_layer" | "ai_fallback";
  targetLabel?: string;
  debug: any;
}> {
  const { imageUrl } = await refineImage(currentImage, instruction, referenceImage, llmProvider);
  return {
    imageUrl,
    layers: existingLayers,
    compositionBaseImage: compositionBaseImage || imageUrl,
    action: "ai_fallback",
    targetLabel: undefined,
    debug: { executedPath: "generate-decoration", requestId: createImageEditRequestId(), timestamp: new Date().toISOString(), instruction, detectedIntent: "ai_direct", hasCompatibleLayer: false, matchedLayerIndex: -1, forceReplaceMode: false, inputBaseImageId: "", inputCurrentImageId: "", inputReferenceImageId: "", outputImageId: "", inputImageHash: "", outputImageHash: "", inputImageLength: 0, outputImageLength: 0 },
  };
}
