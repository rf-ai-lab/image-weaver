import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";

// Model: cjwbw/rembg (background removal / object segmentation)
const MODEL_VERSION = "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003";

function normalizeReplicateToken(rawToken: string | undefined): string {
  if (!rawToken) return "";
  return rawToken.trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "");
}

async function pollPrediction(id: string, token: string, maxAttempts = 60): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(data.error || "Segmentação falhou.");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout: segmentação demorou demais.");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const REPLICATE_API_TOKEN = normalizeReplicateToken(Deno.env.get("REPLICATE_API_TOKEN"));
    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN não está configurado.");

    const { image } = await req.json();
    if (!image) throw new Error("Imagem é obrigatória.");

    console.log("Creating rembg prediction for object segmentation...");

    const createRes = await fetch(`${REPLICATE_API}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION,
        input: { image },
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
      throw new Error(`Replicate API error: ${createRes.status} - ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Segmentation prediction created:", prediction.id);

    const result = await pollPrediction(prediction.id, REPLICATE_API_TOKEN);
    const outputUrl = result.output;
    if (!outputUrl) throw new Error("Nenhuma imagem segmentada foi gerada.");

    return new Response(
      JSON.stringify({ imageUrl: outputUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("segment-object error:", e);
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
