import { supabase } from "@/integrations/supabase/client";
import type { LLMProvider } from "@/pages/Editor";
import type { ObjectLayer } from "@/lib/object-composition";

export function createImageEditRequestId(): string {
  return crypto.randomUUID();
}

export async function refineImage(
  currentImage: string,
  prompt: string,
  referenceImage?: string,
  llmProvider?: LLMProvider,
  sceneDescription?: string,
): Promise<{ imageUrl: string; updatedSceneDescription?: string }> {
  if (!currentImage) throw new Error("Imagem atual é obrigatória.");
  if (!prompt) throw new Error("Prompt é obrigatório.");

  const { data, error } = await supabase.functions.invoke("edit-image", {
    body: {
      image: currentImage,
      prompt,
      scene_description: sceneDescription || "",
    },
  });

  if (error) throw new Error(error.message || "Erro ao chamar Edge Function");
  if (!data) throw new Error("Sem resposta da Edge Function");
  if (!data.imageUrl) throw new Error(data.error || "Nenhuma imagem retornada");

  return {
    imageUrl: data.imageUrl,
    updatedSceneDescription: data.updatedSceneDescription,
  };
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
