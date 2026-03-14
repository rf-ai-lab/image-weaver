import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `VOCÊ É UM EDITOR DE IMAGENS PROFISSIONAL. SIGA ESTAS REGRAS COM RIGOR ABSOLUTO:

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
- Mantenha qualidade e resolução equivalentes à imagem original.`;

// Map provider key to actual model + gateway config
const MODEL_MAP: Record<string, { gateway: "lovable" | "anthropic"; model: string }> = {
  openai: { gateway: "lovable", model: "openai/gpt-5" },
  gemini: { gateway: "lovable", model: "google/gemini-3.1-flash-image-preview" },
  claude: { gateway: "anthropic", model: "claude-sonnet-4-20250514" },
};

async function callLovableGateway(apiKey: string, model: string, content: any[]) {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Lovable gateway error:", response.status, errorText);
    if (response.status === 429) throw { status: 429, message: "Limite de requisições excedido. Tente novamente em alguns segundos." };
    if (response.status === 402) throw { status: 402, message: "Créditos insuficientes. Adicione créditos ao seu workspace." };
    throw new Error(`AI gateway error: ${response.status}`);
  }

  const data = await response.json();
  const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const textResponse = data.choices?.[0]?.message?.content;
  return { imageUrl, textResponse };
}

async function callAnthropic(apiKey: string, model: string, content: any[]) {
  // Convert content array to Anthropic format
  const anthropicContent: any[] = [];
  for (const item of content) {
    if (item.type === "text") {
      anthropicContent.push({ type: "text", text: item.text });
    } else if (item.type === "image_url") {
      const url = item.image_url?.url;
      if (url?.startsWith("data:")) {
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          anthropicContent.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
      } else if (url) {
        anthropicContent.push({
          type: "image",
          source: { type: "url", url },
        });
      }
    }
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: anthropicContent }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Anthropic error:", response.status, errorText);
    if (response.status === 429) throw { status: 429, message: "Limite de requisições do Claude excedido." };
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  // Claude returns text; it doesn't generate images directly.
  // Extract any image URLs from the text response if present.
  const textResponse = data.content?.map((c: any) => c.text).join("\n") || "";
  return { imageUrl: null, textResponse };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

    const { content, model: providerKey } = await req.json();
    if (!content || !Array.isArray(content)) {
      throw new Error("content array is required");
    }

    const provider = providerKey || "gemini";
    const config = MODEL_MAP[provider] || MODEL_MAP["gemini"];

    console.log(`Processing with provider: ${provider}, model: ${config.model}`);

    const systemPromptItem = { type: "text", text: SYSTEM_PROMPT };
    const augmentedContent = [systemPromptItem, ...content];

    let result: { imageUrl: string | null; textResponse: string };

    if (config.gateway === "anthropic") {
      if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY não está configurado.");
      result = await callAnthropic(ANTHROPIC_API_KEY, config.model, augmentedContent);
    } else {
      if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY não está configurado.");
      result = await callLovableGateway(LOVABLE_API_KEY, config.model, augmentedContent);
    }

    if (!result.imageUrl) {
      // If Claude was used (no image generation), return text response
      if (config.gateway === "anthropic") {
        return new Response(
          JSON.stringify({ error: "Claude não gera imagens diretamente. Use OpenAI ou Gemini para geração de imagens, ou use Claude apenas para análise textual.", text: result.textResponse }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error("Nenhuma imagem foi gerada pela IA");
    }

    return new Response(JSON.stringify({ imageUrl: result.imageUrl, text: result.textResponse }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("edit-image error:", e);
    const status = e?.status || 500;
    const message = e?.message || (e instanceof Error ? e.message : "Erro desconhecido");
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
