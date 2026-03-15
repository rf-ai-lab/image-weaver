import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function editWithOpenAI(apiKey: string, currentImage: string, prompt: string, maskImage?: string): Promise<string> {
  const formData = new FormData();
  
  const imageBase64 = currentImage.replace(/^data:image\/\w+;base64,/, "");
  const imageBytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
  formData.append("image", new Blob([imageBytes], { type: "image/png" }), "image.png");
  
  if (maskImage) {
    const maskBase64 = maskImage.replace(/^data:image\/\w+;base64,/, "");
    const maskBytes = Uint8Array.from(atob(maskBase64), c => c.charCodeAt(0));
    formData.append("mask", new Blob([maskBytes], { type: "image/png" }), "mask.png");
  }
  
  formData.append("prompt", prompt);
  formData.append("model", "gpt-image-1");
  formData.append("size", "1024x1024");
  formData.append("quality", "high");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${error}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("Nenhuma imagem retornada pela OpenAI");
  return `data:image/png;base64,${b64}`;
}

async function editWithReplicate(apiKey: string, currentImage: string, prompt: string, maskImage?: string, referenceImage?: string): Promise<string> {
  const input: Record<string, unknown> = {
    image: currentImage,
    prompt,
    num_inference_steps: 28,
    guidance_scale: 60,
  };

  if (maskImage) {
    input.mask = maskImage;
  }

  if (referenceImage) {
    input.prompt = `${prompt}. Use the style and appearance from the reference image.`;
  }

  const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Prefer": "wait",
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Replicate error ${response.status}: ${error}`);
  }

  const prediction = await response.json();
  
  if (prediction.status === "failed") {
    throw new Error(`Replicate prediction failed: ${prediction.error}`);
  }

  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl) throw new Error("Nenhuma imagem retornada pelo Replicate");

  const imgResponse = await fetch(outputUrl);
  const blob = await imgResponse.blob();
  const buffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return `data:image/png;base64,${base64}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const REPLICATE_API_KEY = Deno.env.get("REPLICATE_API_TOKEN");
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!REPLICATE_API_KEY) throw new Error("REPLICATE_API_TOKEN não configurada");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

    const { content, operation } = await req.json();
    if (!content || !Array.isArray(content)) throw new Error("content array é obrigatório");

    const imageUrls = content.filter((i: any) => i?.type === "image_url").map((i: any) => i.image_url?.url as string);
    const texts = content.filter((i: any) => i?.type === "text").map((i: any) => i.text as string);

    const currentImage = imageUrls[0];
    const referenceImage = imageUrls[1] ?? null;
    const maskImage = imageUrls[2] ?? null;
    const prompt = texts.join(" ").trim();

    if (!currentImage) throw new Error("Imagem principal é obrigatória");
    if (!prompt) throw new Error("Prompt é obrigatório");

    console.log("edit-image request", { operation, hasReference: !!referenceImage, hasMask: !!maskImage });

    let imageUrl: string;

    if (referenceImage && maskImage) {
      // Substituição precisa: tem máscara + referência → Flux Fill Pro
      imageUrl = await editWithReplicate(REPLICATE_API_KEY, currentImage, prompt, maskImage, referenceImage);
    } else if (referenceImage) {
      // Tem referência mas sem máscara → Flux Fill Pro sem máscara
      imageUrl = await editWithReplicate(REPLICATE_API_KEY, currentImage, prompt, undefined, referenceImage);
    } else {
      // Só texto (mudar cor, estilo) → GPT-Image-1
      imageUrl = await editWithOpenAI(OPENAI_API_KEY, currentImage, prompt, maskImage ?? undefined);
    }

    return new Response(JSON.stringify({ imageUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("edit-image error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
