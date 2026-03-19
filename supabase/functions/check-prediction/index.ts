import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const REPLICATE_TOKEN = (Deno.env.get("REPLICATE_API_TOKEN") || Deno.env.get("REPLICATE_API_KEY") || "").trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "");
    if (!REPLICATE_TOKEN) throw new Error("REPLICATE token não configurado");

    const { predictionId } = await req.json();
    if (!predictionId) throw new Error("predictionId é obrigatório");

    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` },
    });

    if (!response.ok) throw new Error(`Replicate error: ${response.status}`);
    const result = await response.json();

    if (result.status === "succeeded") {
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      if (!outputUrl) throw new Error("Nenhuma URL de saída");

      // Retorna a URL diretamente sem converter para base64
      return new Response(JSON.stringify({ status: "succeeded", imageUrl: outputUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.status === "failed") {
      return new Response(JSON.stringify({ status: "failed", error: result.error }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ status: result.status }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("check-prediction error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
