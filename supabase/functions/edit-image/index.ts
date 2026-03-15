import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const { content, llmProvider } = await req.json();
    if (!content || !Array.isArray(content)) throw new Error("content array is required");

    const model = llmProvider === "openai" ? "openai/gpt-5" : "google/gemini-3.1-flash-image-preview";

    const systemPrompt = {
      type: "text",
      text: `VOCÊ É UM ESPECIALISTA EM VISUALIZAÇÃO DE DECORAÇÃO DE CASAMENTOS.

REGRA PRINCIPAL: Preserve ABSOLUTAMENTE a fotografia base — mesma locação, mesma perspectiva, mesmos bancos, mesmo gramado, mesma vegetação, mesmo céu, mesmo mar ao fundo. A cena deve ser reconhecível como a mesma foto.

TAREFA: Substitua ou adicione APENAS os elementos decorativos mencionados pelo usuário, mantendo todos os outros elementos da cena intactos.

QUALIDADE: O resultado deve ter qualidade fotográfica realista, como se fosse uma foto real do evento com a nova decoração. Iluminação, sombras e perspectiva devem ser coerentes com a cena original.

PROIBIDO: Alterar o enquadramento, ângulo de câmera, vegetação, estrutura do local, bancos, ou qualquer elemento não mencionado. Nunca gere uma cena completamente diferente.`,
    };

    const body = {
      model,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: [systemPrompt, ...content] }],
    };

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const rawText = await response.text();

    if (!response.ok) {
      console.error("Gateway error:", response.status, rawText);
      let msg = `Erro no gateway: ${response.status}`;
      if (response.status === 429) msg = "Limite de requisições excedido. Tente em alguns segundos.";
      if (response.status === 402) msg = "Créditos insuficientes no workspace do Lovable.";
      return new Response(JSON.stringify({ error: msg, detail: rawText }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = JSON.parse(rawText);
    const imageUrl =
      data.choices?.[0]?.message?.images?.[0]?.image_url?.url ??
      data.choices?.[0]?.message?.content?.[0]?.image_url?.url;

    if (!imageUrl) {
      console.error("No image returned:", JSON.stringify(data).substring(0, 1000));
      return new Response(
        JSON.stringify({ error: "Nenhuma imagem gerada", detail: JSON.stringify(data).substring(0, 500) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ imageUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("edit-image error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
