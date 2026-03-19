import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import type { ObjectLayer } from "@/lib/object-composition";

export function createImageEditRequestId(): string {
  return crypto.randomUUID();
}

async function pollPrediction(predictionId: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    const { data, error } = await supabase.functions.invoke("check-prediction", {
      body: { predictionId },
    });

    if (error) throw new Error(error.message);

    console.log(`Poll ${i + 1}: ${data?.status}`);

    if (data?.status === "succeeded") return data.imageUrl;
    if (data?.status === "failed") throw new Error(`Geração falhou: ${data.error}`);
  }
  throw new Error("Timeout — tente novamente");
}

export async function refineImage(
  currentImage: string,
  prompt: string,
  referenceImage?: string,
  llmProvider?: LLMProvider,
): Promise<{ imageUrl: string }> {
  if (!currentImage) throw new Error("Imagem atual é obrigatória.");

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

  if (data.status === "processing" && data.predictionId) {
    const imageUrl = await pollPrediction(data.predictionId);
    return { imageUrl };
  }

  if (!data.imageUrl) throw new Error(data.error || "Nenhuma imagem retornada");
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
