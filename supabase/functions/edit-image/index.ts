import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LLM_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.0-flash-preview-image-generation",
  openai: "openai/gpt-4o",
  claude: "google/gemini-2.0-flash-preview-image-generation",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const { content, llmProvider } = await req.json();

    if (!content || !Array.isArray(content)) {
      throw new Error("content array is required");
    }

    const model = LLM_MODELS[llmProvider || "gemini"] || LLM_MODELS.gemini;

    const systemPrompt = {
      type: "text",
      text: `VOCÊ É UM EDITOR DE IMAGENS PROFISSIONAL ESPECIALIZADO EM DECORAÇÃO DE CASAMENTOS.

REGRAS ABSOLUTAS:
- A PRIMEIRA imagem enviada é a FOTO PRINCIPAL — preserve seu ângulo, enquadramento, iluminação e elementos não mencionados.
- Imagens subsequentes são REFERÊNCIAS de objetos a inserir ou substituir.
- Execute EXATAMENTE o que o usuário pediu. É PROIBIDO retornar imagem idêntica quando há pedido de edição.
- SUBSTITUIÇÃO: remova o objeto antigo e coloque o novo na mesma posição. Sem duplicações.
- ADIÇÃO: insira o novo objeto respeitando perspectiva e escala da cena.
- TRANSFORMAÇÃO: execute redimensionamento ou reposicionamento conforme instruído.
- O resultado deve parecer foto real, sem artefatos visíveis.`,
    };

    const body = {
      model,
      modalities: ["image", "text"],
      messages: [
        {
          role: "user",
          content: [systemPrompt, ...content],
        },
      ],
    };

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const errorText = await response.text();

    if (!response.ok) {
      console.error("AI gateway error:", response.status, errorText);
      let userMessage = `Erro no gateway: ${response.status}`;
      if (response.status === 429) userMessage = "Limite de requisições excedido. Tente novamente em alguns segundos.";
      if (response.status === 402) userMessage = "Créditos insuficientes no workspace do Lovable.";
      return new Response(
        JSON.stringify({ error: userMessage, detail: errorText }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = JSON.parse(errorText);
    console.log("Gateway response:", JSON.stringify(data).substring(0, 500));

    const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url
      ?? data.choices?.[0]?.message?.content?.[0]?.image_url?.url;

    if (!imageUrl) {
      console.error("No image in response:", JSON.stringify(data).substring(0, 1000));
      return new Response(
        JSON.stringify({ error: "Nenhuma imagem foi gerada pela IA", detail: JSON.stringify(data).substring(0, 500) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ imageUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e) {
    console.error("edit-image error:", e);
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
