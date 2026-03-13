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
- A Imagem Principal é seu TEMPLATE FIXO. Mantenha EXATAMENTE: ângulo de câmera, perspectiva, enquadramento, dimensões e proporções.
- NUNCA corte, recorte, redimensione o canvas ou altere a composição da imagem principal.
- O cenário, fundo, iluminação e temperatura de cor devem permanecer IDÊNTICOS ao original.
- Todos os elementos NÃO mencionados pelo usuário devem permanecer EXATAMENTE como estão.

PRESERVAÇÃO DE ENQUADRAMENTO, DISTÂNCIA E LENTE (REGRA CRÍTICA):
- Distância da câmera ao cenário é IMUTÁVEL, salvo pedido explícito do usuário.
- É PROIBIDO aplicar zoom in, zoom out, crop, reframe, pan, tilt, mudança de lente, mudança de distância focal percebida ou aproximação da câmera.
- A área visível final deve ser a MESMA da foto inicial: sem perder céu, chão ou laterais.
- A proporção final (aspect ratio) e o campo de visão macro devem permanecer IDÊNTICOS ao original.
- Se imagens de referência tiverem resolução/proporção diferentes, adapte APENAS os elementos extraídos; NUNCA adapte o enquadramento da imagem principal.

PRESERVAÇÃO DE DIMENSÕES E PROPORÇÕES DOS ELEMENTOS (REGRA CRÍTICA):
- CADA elemento da imagem possui dimensões específicas (largura, altura, profundidade visual). Essas dimensões são IMUTÁVEIS, exceto se o usuário pedir redimensionamento explícito.
- Se o usuário pedir para alterar COR, TEXTURA ou MATERIAL: mude APENAS a aparência visual. O TAMANHO, FORMA, POSIÇÃO e PROPORÇÃO devem permanecer IDÊNTICOS.
- Portais, arcos, estruturas, móveis e objetos decorativos devem manter dimensões exatas.
- Arranjos de flores, vasos, bancos e demais objetos: se não foi pedido para mover/redimensionar, mantenha no MESMO local e com o MESMO tamanho.

PROCESSAMENTO DE INSTRUÇÕES:
- Leia TODAS as instruções do usuário antes de começar e execute CADA UMA.
- Se houver múltiplas imagens de referência, extraia de CADA UMA exatamente o que foi solicitado.
- Quando o usuário pedir para "trocar" ou "substituir" um elemento: remova o original e coloque o novo NO MESMO LOCAL, com MESMO TAMANHO e PROPORÇÃO coerente.
- Quando o usuário pedir para "adicionar": insira o elemento respeitando perspectiva e escala do cenário existente.
- Quando o usuário pedir para alterar CORES ou APARÊNCIA: modifique SOMENTE cor/aparência. NÃO altere tamanho, forma, posição, enquadramento ou distância de câmera.

IMAGENS DE REFERÊNCIA:
- Use as imagens de referência APENAS como fonte dos elementos solicitados.
- Extraia SOMENTE o que o usuário pediu (ex: "os arranjos de flores" = apenas os arranjos, não o cenário da referência).
- Adapte os elementos extraídos à iluminação e perspectiva da imagem principal, sem alterar o campo de visão da imagem base.

MARCAÇÕES VISUAIS:
- Traços, círculos ou setas em VERMELHO são anotações do usuário indicando áreas específicas.
- Use como guia de localização e REMOVA todas as marcações no resultado final.

CHECKLIST FINAL OBRIGATÓRIO (ANTES DE ENTREGAR):
- O enquadramento final é idêntico ao original, sem cortes adicionais?
- A distância/ângulo da câmera permanecem iguais ao original?
- Algum elemento mudou de tamanho sem instrução explícita? Se sim, corrija.

RESULTADO:
- A imagem final deve parecer uma foto real, coerente e sem artefatos visíveis.
- Mantenha qualidade e resolução equivalentes à imagem original.`
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
