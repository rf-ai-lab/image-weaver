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

    const { content, model } = await req.json();
    if (!content || !Array.isArray(content)) {
      throw new Error("content array is required");
    }
    const selectedModel = model || "google/gemini-3.1-flash-image-preview";

    const systemPrompt = {
      type: "text",
      text: `VOCÊ É UM EDITOR DE IMAGENS PROFISSIONAL. SIGA ESTAS REGRAS COM RIGOR ABSOLUTO:

IDENTIFICAÇÃO DA IMAGEM PRINCIPAL (REGRA FUNDAMENTAL):
- A PRIMEIRA image_url enviada pelo usuário é SEMPRE a FOTO PRINCIPAL (TEMPLATE FIXO).
- Toda edição deve preservar a macroestrutura dessa primeira imagem.
- Imagens subsequentes são apenas referências de objetos e nunca podem substituir a estrutura da principal.

PRESERVAÇÃO DA IMAGEM PRINCIPAL:
- Mantenha EXATAMENTE: ângulo de câmera, perspectiva, enquadramento, dimensões e proporções.
- NUNCA corte, recorte, redimensione o canvas ou altere a composição da imagem principal.
- O cenário, fundo, iluminação e temperatura de cor devem permanecer IDÊNTICOS ao original.
- Todos os elementos NÃO mencionados pelo usuário devem permanecer EXATAMENTE como estão.

PRESERVAÇÃO DE ENQUADRAMENTO, DISTÂNCIA E LENTE (REGRA CRÍTICA):
- Distância da câmera ao cenário é IMUTÁVEL, salvo pedido explícito do usuário.
- É PROIBIDO aplicar zoom in, zoom out, crop, reframe, pan, tilt, mudança de lente, mudança de distância focal percebida ou aproximação da câmera.
- A área visível final deve ser a MESMA da foto inicial: sem perder céu, chão ou laterais.
- A proporção final (aspect ratio) e o campo de visão macro devem permanecer IDÊNTICOS ao original.
- Se referências tiverem resolução/proporção diferentes, adapte APENAS os objetos extraídos; NUNCA adapte o enquadramento da principal.

PRESERVAÇÃO DE DIMENSÕES E PROPORÇÕES DOS ELEMENTOS (REGRA CRÍTICA):
- CADA elemento da imagem possui dimensões específicas. Essas dimensões são IMUTÁVEIS, exceto se o usuário pedir redimensionamento explícito.
- Se o usuário pedir para alterar COR, TEXTURA ou MATERIAL: mude APENAS a aparência visual.
- Portais, arcos, estruturas, móveis e objetos decorativos devem manter dimensões exatas.
- Arranjos de flores, vasos, bancos e demais objetos: se não foi pedido para mover/redimensionar, mantenha no MESMO local e com o MESMO tamanho.

LÓGICA FIXA DE PROCESSAMENTO:
- Execute TODAS as instruções de texto do usuário.
- A FOTO PRINCIPAL define exclusivamente a estrutura macro (ângulo/zoom/enquadramento/câmera).
- A IMAGEM DE TRABALHO define exclusivamente o estado atual dos elementos (o que existe e o que foi removido).
- Para cada imagem de referência enviada após a principal: (1) identificar objetos citados, (2) extrair apenas esses objetos, (3) inserir na FOTO PRINCIPAL.
- Ao "trocar/substituir", coloque no MESMO LOCAL e com MESMO TAMANHO do elemento anterior, salvo instrução contrária.
- Ao "adicionar", respeite perspectiva, escala e iluminação da foto principal.
- Ao alterar apenas cor/aparência, NÃO altere tamanho, forma, posição, enquadramento ou distância de câmera.

REGRA CRÍTICA DE CONTINUIDADE (NÃO REINTRODUÇÃO):
- NUNCA reintroduza, recrie ou faça reaparecer itens do projeto inicial que não estejam visíveis na IMAGEM DE TRABALHO atual.
- Se um item não está na IMAGEM DE TRABALHO, trate como removido intencionalmente e mantenha AUSENTE.
- Só traga um item removido de volta se o usuário pedir de forma EXPLÍCITA (ex.: "recolocar", "trazer de volta", "reintroduzir").

MARCAÇÕES VISUAIS:
- Traços, círculos ou setas em VERMELHO são guias de localização.
- REMOVA todas as marcações no resultado final.

CHECKLIST FINAL OBRIGATÓRIO (ANTES DE ENTREGAR):
- O enquadramento final é idêntico ao original, sem cortes?
- A distância/ângulo da câmera permanecem iguais?
- Algum elemento mudou de tamanho sem instrução explícita?

RESULTADO:
- A imagem final deve parecer foto real, coerente e sem artefatos visíveis.
- Mantenha qualidade e resolução equivalentes à imagem original.`,
    };

    const augmentedContent = [systemPrompt, ...content];

    const isGeminiImageModel = selectedModel.includes("image");
    console.log(`Calling AI gateway with ${selectedModel} (image model: ${isGeminiImageModel})...`);

    const requestBody: Record<string, unknown> = {
      model: selectedModel,
      messages: [
        {
          role: "user",
          content: augmentedContent,
        },
      ],
    };

    // Only Gemini image models support the modalities parameter
    if (isGeminiImageModel) {
      requestBody.modalities = ["image", "text"];
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
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

    return new Response(JSON.stringify({ imageUrl, text: textResponse }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("edit-image error:", e);
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

