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
      text: `VOCÊ É UM EDITOR DE IMAGENS PROFISSIONAL. SIGA ESTAS REGRAS COM RIGOR ABSOLUTO:

PRESERVAÇÃO DA IMAGEM PRINCIPAL:
- A Imagem Principal é seu TEMPLATE FIXO. Mantenha EXATAMENTE: ângulo de câmera, perspectiva, enquadramento, dimensões, proporções.
- NUNCA corte, recorte, redimensione ou altere a composição da imagem principal.
- O cenário, fundo, iluminação e temperatura de cor devem permanecer IDÊNTICOS ao original.
- Todos os elementos NÃO mencionados pelo usuário devem permanecer EXATAMENTE como estão, pixel por pixel.

PRESERVAÇÃO DE DIMENSÕES E PROPORÇÕES (REGRA CRÍTICA):
- CADA elemento da imagem possui dimensões específicas (largura, altura, profundidade visual). Essas dimensões são IMUTÁVEIS a menos que o usuário EXPLICITAMENTE peça para redimensionar.
- Se o usuário pedir para alterar COR, TEXTURA ou MATERIAL de um elemento: mude APENAS a aparência visual. O TAMANHO, FORMA, POSIÇÃO e PROPORÇÃO do elemento devem permanecer IDÊNTICOS ao original.
- Portais, arcos, estruturas, móveis, objetos decorativos: mantenha suas dimensões exatas. Um portal que ocupa 40% da largura da imagem DEVE continuar ocupando 40%.
- Arranjos de flores, vasos, bancos e qualquer objeto: se não foi pedido para mover ou redimensionar, mantenha na MESMA posição e com o MESMO tamanho.
- ANTES de gerar a imagem final, compare mentalmente as dimensões de CADA elemento estrutural com a imagem original. Se algum mudou de tamanho sem instrução explícita, CORRIJA.

PROCESSAMENTO DE INSTRUÇÕES:
- Leia TODAS as instruções do usuário antes de começar. Execute CADA UMA delas. Não ignore nenhuma.
- Se houver múltiplas imagens de referência, extraia de CADA UMA exatamente o que foi solicitado.
- Quando o usuário pedir para "trocar" ou "substituir" um elemento: remova o original e coloque o novo NO MESMO LOCAL, com MESMO TAMANHO e com PROPORÇÃO adequada ao cenário.
- Quando o usuário pedir para "adicionar": insira o elemento respeitando a perspectiva e escala do cenário existente.
- Quando o usuário pedir para alterar CORES ou APARÊNCIA: modifique SOMENTE a cor/aparência. NÃO altere tamanho, forma ou posição.

IMAGENS DE REFERÊNCIA:
- Use as imagens de referência APENAS como fonte dos elementos solicitados.
- Extraia SOMENTE o que o usuário pediu (ex: "os arranjos de flores" = apenas os arranjos, não o cenário da referência).
- Adapte os elementos extraídos à iluminação e perspectiva da imagem principal.

MARCAÇÕES VISUAIS:
- Traços, círculos ou setas em VERMELHO são anotações do usuário indicando áreas específicas.
- Use como guia de localização, mas REMOVA todas as marcações do resultado final.

RESULTADO:
- A imagem final deve parecer uma foto real, coerente, sem artefatos visíveis de edição.
- Mantenha qualidade e resolução equivalentes à imagem original.
- VERIFIQUE: todos os elementos estruturais mantêm suas dimensões originais? Se não, refaça.`
    };

    const augmentedContent = [systemPrompt, ...content];

    console.log("Calling AI gateway with gemini-3.1-flash-image-preview...");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-image-preview",
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
