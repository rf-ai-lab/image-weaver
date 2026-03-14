import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Map provider names to gateway model IDs
const LLM_MODELS: Record<string, string> = {
  gemini: "google/gemini-3.1-flash-image-preview",
  openai: "openai/gpt-5",
  claude: "google/gemini-2.5-pro", // Claude not available on gateway, fallback to best alternative
};

function summarizeContent(content: any[]): unknown[] {
  return content.map((item, index) => {
    if (item?.type === "text") {
      const text = String(item.text || "").replace(/\s+/g, " ").trim();
      return {
        index,
        type: "text",
        length: text.length,
        preview: text.slice(0, 220),
      };
    }

    if (item?.type === "image_url") {
      const url = item?.image_url?.url || "";
      return {
        index,
        type: "image_url",
        isDataUrl: typeof url === "string" ? url.startsWith("data:") : false,
        length: typeof url === "string" ? url.length : 0,
        preview: typeof url === "string" ? url.slice(0, 140) : "",
      };
    }

    return { index, type: item?.type || "unknown" };
  });
}

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

PRESERVAÇÃO DE DIMENSÕES E PROPORÇÕES DOS ELEMENTOS (REGRA CRÍTICA):
- CADA elemento da imagem possui dimensões específicas. Essas dimensões são IMUTÁVEIS, exceto se o usuário pedir redimensionamento explícito.
- Portais, arcos, estruturas, móveis e objetos decorativos devem manter dimensões exatas.

REGRA ANTI-DUPLICAÇÃO (CRÍTICA):
- Quando o usuário pedir para TROCAR, SUBSTITUIR ou usar uma referência "no lugar de" um elemento existente:
  1. IDENTIFIQUE o elemento alvo existente na cena (arco, portal, altar, arranjo, etc.).
  2. REMOVA completamente o elemento antigo.
  3. Coloque o NOVO elemento da referência NA MESMA POSIÇÃO e com PROPORÇÕES SIMILARES ao antigo.
  4. NUNCA adicione um segundo exemplar do mesmo tipo de objeto.
  5. NUNCA posicione o novo objeto no primeiro plano / foreground da cena.
  6. Se a cena tem 1 arco e o usuário pede para trocar, o resultado deve ter EXATAMENTE 1 arco.

REGRA DE POSICIONAMENTO:
- Objetos substituídos devem ocupar a MESMA região espacial do objeto original.
- Respeitar profundidade: objeto no fundo continua no fundo.
- Não trazer objetos para frente da câmera.
- Manter coerência de escala com os outros elementos da cena.

LÓGICA FIXA DE PROCESSAMENTO:
- Execute TODAS as instruções de texto do usuário.
- A FOTO PRINCIPAL define exclusivamente a estrutura macro (ângulo/zoom/enquadramento/câmera).
- A IMAGEM DE TRABALHO define exclusivamente o estado atual dos elementos.
- Ao "trocar/substituir", coloque no MESMO LOCAL e com MESMO TAMANHO do elemento anterior.
- Ao "adicionar", respeite perspectiva, escala e iluminação da foto principal.

REGRA CRÍTICA DE CONTINUIDADE (NÃO REINTRODUÇÃO):
- NUNCA reintroduza itens do projeto inicial que não estejam visíveis na IMAGEM DE TRABALHO atual.
- Se um item não está na IMAGEM DE TRABALHO, trate como removido e mantenha AUSENTE.

MARCAÇÕES VISUAIS:
- Traços, círculos ou setas em VERMELHO são guias de localização.
- REMOVA todas as marcações no resultado final.

CHECKLIST FINAL OBRIGATÓRIO:
- O enquadramento final é idêntico ao original?
- Existe duplicação de algum objeto (dois arcos, dois altares)?
- Algum objeto novo apareceu no foreground sem instrução?
- O restante da cena (bancos, vegetação, horizonte, gramado) permanece intacto?

RESULTADO:
- A imagem final deve parecer foto real, coerente e sem artefatos visíveis.
- Mantenha qualidade e resolução equivalentes à imagem original.`,
    };

    const augmentedContent = [systemPrompt, ...content];

    console.log(`Calling AI gateway with model: ${model}...`);

    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: "user",
          content: augmentedContent,
        },
      ],
    };

    // Only Gemini image models support modalities
    if (model.includes("gemini") && model.includes("image")) {
      body.modalities = ["image", "text"];
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
