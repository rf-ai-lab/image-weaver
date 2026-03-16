import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const REPLICATE_API_KEY = Deno.env.get("REPLICATE_API_KEY") || Deno.env.get("REPLICATE_API_TOKEN");
    if (!REPLICATE_API_KEY) throw new Error("REPLICATE_API_KEY não configurada");

    const { predictionId } = await req.json();
    if (!predictionId) throw new Error("predictionId é obrigatório");

    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` },
    });

    if (!response.ok) throw new Error(`Replicate error: ${response.status}`);
    const result = await response.json();

    if (result.status === "succeeded") {
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      if (!outputUrl) throw new Error("Nenhuma URL de saída");

      // Baixa a imagem e converte para base64
      const imgResponse = await fetch(outputUrl);
      const arrayBuffer = await imgResponse.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      let binary = "";
      const chunkSize = 1024;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      const base64 = btoa(binary);
      const imageUrl = `data:image/png;base64,${base64}`;

      return new Response(JSON.stringify({ status: "succeeded", imageUrl }), {
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
