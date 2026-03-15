import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function toBase64DataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const res = await fetch(url);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mime = blob.type || "image/png";
  return `data:${mime};base64,${base64}`;
}

async function editWithOpenAI(apiKey: string, currentImage: string, prompt: string): Promise<string> {
  const dataUrl = await toBase64DataUrl(currentImage);
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const imageBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

  const formData = new FormData();
  formData.append("image", new Blob([imageBytes], { type: "image/png" }), "image.png");
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

async function editWithReplicate(apiKey: string, currentImage: string, prompt: string, referenceImage?: string): Promise<string> {
  const baseDataUrl = await toBase64DataUrl(currentImage);

  const input: Record<string, unknown> = {
    image: baseDataUrl,
    prompt,
    num_inference_steps: 28,
    guidance_scale: 60,
  };

  if (referenceImage) {
    const refDataUrl = await toBase64DataUrl(referenceImage);
    input.prompt = `${prompt}. Incorporate the object from the reference image maintaining the same position and scale as the original object in the scene.`;
    input.reference_image = refDataUrl;
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
  if (prediction.status === "failed") throw new Error(`Replicate falhou: ${prediction.error}`);

  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl) throw new Error("Nenhuma imagem retornada pelo Replicate");

  return await toBase64DataUrl(outputUrl);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const REPLICATE_API_KEY = Deno.env.get("REPLICATE_API_KEY") || Deno.env.get("REPLICATE_API_TOKEN");
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!REPLICATE_API_KEY) throw new Error("REPLICATE_API_KEY não configurada no Supabase");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada no Supabase");

    const { content } = await req.json();
    if (!content || !Array.isArray(content)) throw new Error("content array é obrigatório");

    const imageUrls: string[] = content
      .filter((i: any) => i?.type === "image_url")
      .map((i: any) => i.image_url?.url as string);

    const texts: string[] = content
      .filter((i: any) => i?.type === "text")
      .map((i: any) => i.text as string);

    const currentImage = imageUrls[0];
    const referenceImage = imageUrls[1] ?? null;
    const prompt = texts.filter(t => !t.includes("REFERÊNCIA")).join(" ").trim();

    if (!currentImage) throw new Error("Imagem principal é obrigatória");
    if (!prompt) throw new Error("Prompt é obrigatório");

    console.log("edit-image:", { hasReference: !!referenceImage, promptLength: prompt.length });

    let imageUrl: string;

    if (referenceImage) {
      imageUrl = await editWithReplicate(REPLICATE_API_KEY, currentImage, prompt, referenceImage);
    } else {
      imageUrl = await editWithOpenAI(OPENAI_API_KEY, currentImage, prompt);
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
