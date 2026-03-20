import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";
const MODEL_VERSION = "06d6fae3b75ab68a28cd2900afa6033166910dd09fd9751047043a5bbb4c184b";

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
            content: `You are a prompt engineer for SDXL ControlNet image editing specialized in wedding venue decoration. Given a user instruction in any language, produce a concise English prompt. Rules: output ONLY the prompt. Describe the full desired scene including all decoration elements. Be specific about colors, materials, sizes and placement. End with: "Photorealistic wedding venue, high quality photography, sharp details."`,
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
    return `Wedding venue decoration: ${instruction}. Photorealistic wedding venue, high quality photography, sharp details.`;
  }
}

async function pollPrediction(id: string, token: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(data.error || "Geração falhou.");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout.");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const REPLICATE_TOKEN = normalizeToken(Deno.env.get("REPLICATE_API_TOKEN") || Deno.env.get("REPLICATE_API_KEY"));
    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!REPLICATE_TOKEN) throw new Error("REPLICATE_API_TOKEN não configurado.");
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY não configurada.");

    const { image, prompt } = await req.json();
    if (!image) throw new Error("Imagem é obrigatória.");
    if (!prompt) throw new Error("Prompt é obrigatório.");

    const optimizedPrompt = await optimizePrompt(prompt, OPENAI_KEY);
    console.log("Optimized prompt:", optimizedPrompt);

    const createRes = await fetch(`${REPLICATE_API}/predictions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: MODEL_VERSION,
        input: {
          image,
          prompt: optimizedPrompt,
          num_inference_steps: 30,
          condition_scale: 0.8,
          guidance_scale: 7.5,
          seed: 0,
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Replicate error ${createRes.status}: ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Prediction created:", prediction.id);

    const result = await pollPrediction(prediction.id, REPLICATE_TOKEN);
    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!outputUrl) throw new Error("Nenhuma imagem gerada.");

    return new Response(
      JSON.stringify({ imageUrl: outputUrl, optimizedPrompt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("generate-decoration error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
