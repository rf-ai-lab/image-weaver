import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";
const PIX2PIX_VERSION = "30c1d0b916a6f8efce20493f5d61ee27491ab2a60437c13c588468b9810ec23f";

function normalizeToken(raw: string | undefined): string {
  if (!raw) return "";
  return raw.trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "");
}

async function optimizePrompt(instruction: string, openaiKey: string): Promise<string> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a prompt engineer for instruct-pix2pix Stable Diffusion image editing specialized in wedding venue decoration. Given a user instruction in any language, produce a concise English prompt. Rules: output ONLY the prompt text. Keep same camera angle, perspective and background. Be specific about colors, materials and placement. End with: "Photorealistic, high quality, maintain original perspective and camera angle."`,
          },
          { role: "user", content: instruction },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || instruction;
  } catch (e) {
    console.error("Prompt optimization failed:", e);
    return `Wedding decoration edit: ${instruction}. Keep exact camera angle and background. Photorealistic, high quality, maintain original perspective and camera angle.`;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const REPLICATE_TOKEN = normalizeToken(Deno.env.get("REPLICATE_API_TOKEN") || Deno.env.get("REPLICATE_API_KEY"));
    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!REPLICATE_TOKEN) throw new Error("REPLICATE_API_TOKEN não configurado.");
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY não configurada.");

    const { content } = await req.json();
    if (!content || !Array.isArray(content)) throw new Error("content array é obrigatório");

    const imageUrls: string[] = content.filter((i: any) => i?.type === "image_url").map((i: any) => i.image_url?.url as string);
    const texts: string[] = content.filter((i: any) => i?.type === "text").map((i: any) => i.text as string);

    const currentImage = imageUrls[0];
    const prompt = texts.filter(t => !t.includes("REFERÊNCIA")).join(" ").trim();

    if (!currentImage) throw new Error("Imagem principal é obrigatória");
    if (!prompt) throw new Error("Prompt é obrigatório");

    const optimizedPrompt = await optimizePrompt(prompt, OPENAI_KEY);
    console.log("Optimized prompt:", optimizedPrompt);

    const createRes = await fetch(`${REPLICATE_API}/predictions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: PIX2PIX_VERSION,
        input: {
          image: currentImage,
          prompt: optimizedPrompt,
          num_inference_steps: 30,
          image_guidance_scale: 1.2,
          guidance_scale: 7.5,
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Replicate error ${createRes.status}: ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Prediction created:", prediction.id);

    return new Response(JSON.stringify({ status: "processing", predictionId: prediction.id }), {
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
