import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import type { ObjectLayer } from "@/lib/object-composition";

export function createImageEditRequestId(): string {
  return crypto.randomUUID();
}

async function pollReplicate(predictionId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const result = await response.json();
    console.log(`Replicate poll ${i + 1}: ${result.status}`);

    if (result.status === "succeeded") {
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      if (!outputUrl) throw new Error("Nenhuma imagem retornada pelo Replicate");

      // Converte URL para base64
      const imgResponse = await fetch(outputUrl);
      const blob = await imgResponse.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    if (result.status === "failed") {
      throw new Error(`Replicate falhou: ${result.error}`);
    }
  }
  throw new Error("Timeout — geração demorou mais de 3 minutos");
}

export async function refineImage(
  currentImage: string,
  prompt: string,
  referenceImage?: string,
  llmProvider?: LLMProvider,
): Promise<{ imageUrl: string }> {
  if (!currentImage) throw new Error("Imagem atual é obrigatória.");
  if (!prompt && !referenceImage) throw new Error("Prompt ou imagem de referência é obrigatório.");

  const content: any[] = [{ type: "image_url", image_url: { url: currentImage } }];

  if (referenceImage) {
    content.push({ type: "text", text: "A imagem a seguir é uma REFERÊNCIA:" });
    content.push({ type: "image_url", image_url: { url: referenceImage } });
  }

  if (prompt) content.push({ type: "text", text: prompt });

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: { content },
  });

  if (error) throw new Error(error.message || "Erro ao chamar Edge Function");
  if (!data) throw new Error("Sem resposta da Edge Function");

  // Se Replicate está processando, faz polling no frontend
  if (data.status === "processing" && data.predictionId) {
    console.log("Replicate processing, polling...", data.predictionId);
    const imageUrl = await pollReplicate(data.predictionId, data.replicateApiKey);
    return { imageUrl };
  }

  if (!data.imageUrl) throw new Error("Nenhuma imagem retornada");
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
  llmProvider?: LLMProvider;
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
    debug: { executedPath: "ai_direct", requestId: createImageEditRequestId(), timestamp: new Date().toISOString(), instruction, detectedIntent: "ai_direct", hasCompatibleLayer: false, matchedLayerIndex: -1, forceReplaceMode: false, inputBaseImageId: "", inputCurrentImageId: "", inputReferenceImageId: "", outputImageId: "", inputImageHash: "", outputImageHash: "", inputImageLength: 0, outputImageLength: 0 },
  };
}
