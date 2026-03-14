import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";

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

    // Wait 2 seconds between polls
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout: a geração demorou demais.");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");
    if (!REPLICATE_API_TOKEN) {
      throw new Error("REPLICATE_API_TOKEN não está configurado.");
    }

    const { image, prompt } = await req.json();

    if (!image) throw new Error("Imagem é obrigatória.");
    if (!prompt) throw new Error("Prompt é obrigatório.");

    // Build a decoration-specific prompt
    const decorationPrompt = `Wedding venue decoration edit: ${prompt}. Maintain the exact same camera angle, perspective, and background. Photorealistic result.`;

    console.log("Creating Replicate prediction with instruct-pix2pix...");

    // Create prediction using instruct-pix2pix model
    const createRes = await fetch(`${REPLICATE_API}/models/timothybrooks/instruct-pix2pix/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          image,
          prompt: decorationPrompt,
          num_inference_steps: 50,
          image_guidance_scale: 1.5,
          guidance_scale: 7.5,
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error("Replicate create error:", createRes.status, errText);

      if (createRes.status === 401 || createRes.status === 403) {
        return new Response(
          JSON.stringify({ error: "Token da API Replicate inválido ou sem permissão." }),
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
          JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns segundos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Replicate API error: ${createRes.status} - ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Prediction created:", prediction.id);

    // Poll for completion
    const result = await pollPrediction(prediction.id, REPLICATE_API_TOKEN);
    console.log("Prediction completed:", result.id);

    // instruct-pix2pix returns an array of image URLs
    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;

    if (!outputUrl) {
      throw new Error("Nenhuma imagem foi gerada pelo modelo.");
    }

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
