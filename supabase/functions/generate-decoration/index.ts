import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";

// Model: lucataco/sdxl-controlnet (canny edge detection for structure preservation)
const MODEL_VERSION = "06d6fae3b75ab68a28cd2900afa6033166910dd09fd9751047043a5bbb4c184b";

async function pollPrediction(id: string, token: string, maxAttempts = 60): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(data.error || "A geração da imagem falhou.");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout: a geração demorou demais.");
}

function normalizeReplicateToken(rawToken: string | undefined): string {
  if (!rawToken) return "";
  return rawToken.trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const REPLICATE_API_TOKEN = normalizeReplicateToken(Deno.env.get("REPLICATE_API_TOKEN"));
    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN não está configurado.");

    const { image, prompt } = await req.json();

    if (!image) throw new Error("Imagem é obrigatória.");
    if (!prompt) throw new Error("Prompt é obrigatório.");

    console.log("Creating Replicate prediction (SDXL ControlNet, image-to-image)...");
    console.log("Prompt:", prompt);

    const replicateInput = {
      image,
      prompt,
      num_inference_steps: 30,
      condition_scale: 0.8,
      guidance_scale: 7.5,
      seed: 0,
    };

    const createRes = await fetch(`${REPLICATE_API}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION,
        input: replicateInput,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error("Replicate create error:", createRes.status, errText);

      if (createRes.status === 401 || createRes.status === 403) {
        return new Response(
          JSON.stringify({ error: "Token da API Replicate inválido." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (createRes.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos insuficientes na conta Replicate." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (createRes.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições excedido." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Replicate API error: ${createRes.status} - ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Prediction created:", prediction.id);

    const result = await pollPrediction(prediction.id, REPLICATE_API_TOKEN);
    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!outputUrl) throw new Error("Nenhuma imagem foi gerada pelo modelo.");

    return new Response(
      JSON.stringify({ imageUrl: outputUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("generate-decoration error:", e);
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
