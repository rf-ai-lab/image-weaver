import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const { content } = await req.json();
    if (!content || !Array.isArray(content)) {
      throw new Error("content array is required");
    }

    // Inject system-level instructions to preserve scene integrity
    const systemPrompt = {
      type: "text",
      text: `REGRAS OBRIGATÓRIAS QUE VOCÊ DEVE SEGUIR:
1. NUNCA altere o ângulo da câmera, perspectiva ou enquadramento da imagem. A composição deve permanecer IDÊNTICA.
2. NUNCA corte, recorte ou redimensione a imagem. Mantenha EXATAMENTE as mesmas dimensões e área visível.
3. O cenário/fundo deve permanecer ESTÁTICO e inalterado, a menos que explicitamente solicitado pelo usuário.
4. Apenas modifique os elementos ESPECÍFICOS mencionados pelo usuário. Tudo o que não foi mencionado deve permanecer EXATAMENTE como está.
5. Se o usuário der MÚLTIPLAS instruções, execute TODAS elas. Não ignore nenhuma instrução. Processe cada pedido individualmente.
6. Se a imagem contiver marcações visuais (traços vermelhos, círculos, setas em vermelho brilhante), elas são ANOTAÇÕES do usuário indicando EXATAMENTE quais áreas devem ser modificadas. Use essas marcações como guia para localizar as áreas a alterar, mas REMOVA as marcações da imagem final.
7. Preserve a iluminação, temperatura de cor e estilo visual original.`
    };

    // Prepend system instructions to content
    const augmentedContent = [systemPrompt, ...content];

    console.log("Calling AI gateway for image editing...");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [
          {
            role: "user",
            content: augmentedContent,
          },
        ],
        modalities: ["image", "text"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);

      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns segundos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao seu workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    const textResponse = data.choices?.[0]?.message?.content;

    if (!imageUrl) {
      console.error("No image in response:", JSON.stringify(data).substring(0, 500));
      throw new Error("Nenhuma imagem foi gerada pela IA");
    }

    return new Response(
      JSON.stringify({ imageUrl, text: textResponse }),
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
