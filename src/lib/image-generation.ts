import { supabase } from "@/integrations/supabase/client";

type LlmProvider = "openai" | "claude" | "gemini";

type GenerateImageParams = {
  image: string;
  prompt: string;
  llmProvider?: LlmProvider;
};

type FunctionInvokeError = {
  message?: string;
  context?: {
    status?: number;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  };
};

export type GenerateImageResult = {
  imageUrl: string;
  usedFallback: boolean;
};

const BILLING_ERROR_REGEX = /insufficient credit|créditos insuficientes/i;

async function parseInvokeError(error: FunctionInvokeError): Promise<{ status?: number; message: string }> {
  const status = error?.context?.status;
  let message = error?.message || "Erro ao processar imagem.";

  if (typeof error?.context?.json === "function") {
    try {
      const body = (await error.context.json()) as { error?: string; message?: string };
      message = body?.error || body?.message || message;
      return { status, message };
    } catch {
      // ignore JSON parsing failures
    }
  }

  if (typeof error?.context?.text === "function") {
    try {
      const rawText = await error.context.text();
      if (rawText) message = rawText;
    } catch {
      // ignore text parsing failures
    }
  }

  return { status, message };
}

function isBillingError(status?: number, message?: string) {
  return status === 402 || BILLING_ERROR_REGEX.test(message || "");
}

export async function generateImageWithFallback({ image, prompt, llmProvider = "openai" }: GenerateImageParams): Promise<GenerateImageResult> {
  const { data, error } = await supabase.functions.invoke("generate-decoration", {
    body: { image, prompt, llm_provider: llmProvider },
  });

  if (!error) {
    if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada.");
    return { imageUrl: data.imageUrl, usedFallback: false };
  }

  const parsedError = await parseInvokeError(error as FunctionInvokeError);
  if (!isBillingError(parsedError.status, parsedError.message)) {
    throw new Error(parsedError.message || "Erro ao gerar imagem.");
  }

  const fallbackContent = [
    { type: "image_url", image_url: { url: image } },
    { type: "text", text: prompt },
  ];

  const { data: fallbackData, error: fallbackError } = await supabase.functions.invoke("edit-image", {
    body: { content: fallbackContent },
  });

  if (fallbackError) {
    const parsedFallbackError = await parseInvokeError(fallbackError as FunctionInvokeError);
    throw new Error(parsedFallbackError.message || "Sem créditos no provedor atual e o fallback também falhou.");
  }

  if (!fallbackData?.imageUrl) {
    throw new Error("Nenhuma imagem retornada no fallback.");
  }

  return { imageUrl: fallbackData.imageUrl, usedFallback: true };
}
