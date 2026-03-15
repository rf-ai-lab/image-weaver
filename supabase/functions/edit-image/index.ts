import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Map provider names to gateway model IDs
const LLM_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.0-flash-exp",
  openai: "openai/gpt-4o",
  claude: "google/gemini-2.0-flash-exp",
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

function createStableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function imageTrace(image: string | null | undefined) {
  if (!image) {
    return {
      hash: "null",
      length: 0,
      preview: "null",
      identifier: "null",
    };
  }

  const sample = image.startsWith("data:") ? image.slice(Math.max(0, image.length - 4096)) : image;
  const hash = createStableHash(sample);
  const preview = image.length > 96 ? `${image.slice(0, 48)}...${image.slice(-48)}` : image;
  return {
    hash,
    length: image.length,
    preview,
    identifier: image.startsWith("data:") ? `data:len=${image.length};hash=${hash}` : `url:${preview};hash=${hash}`,
  };
}

function findImageUrls(content: any[]): string[] {
  return content
    .filter((item) => item?.type === "image_url" && typeof item?.image_url?.url === "string")
    .map((item) => item.image_url.url as string);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const {
      content,
      llmProvider,
      requestId,
      operation,
      inputImageHash: forwardedInputImageHash,
      referenceImageHash: forwardedReferenceImageHash,
    } = await req.json();

    if (!content || !Array.isArray(content)) {
      throw new Error("content array is required");
    }

    const effectiveRequestId = requestId || crypto.randomUUID();
    const model = LLM_MODELS[llmProvider || "gemini"] || LLM_MODELS.gemini;
    const imageUrls = findImageUrls(content);
    const inputImage = imageUrls[0] ?? null;
    const referenceImage = imageUrls[1] ?? null;
    const inputTrace = imageTrace(inputImage);
    const referenceTrace = imageTrace(referenceImage);

    console.log("[ReferenceEditDebug][edit-image] request", {
      timestamp: new Date().toISOString(),
      requestId: effectiveRequestId,
      operation: operation || "unspecified",
      llmProvider: llmProvider || "gemini",
      model,
      cacheUsed: false,
      inputImageHash: forwardedInputImageHash || inputTrace.hash,
      referenceImageHash: forwardedReferenceImageHash || referenceTrace.hash,
      inputImageLength: inputTrace.length,
      referenceImageLength: referenceTrace.length,
      inputImagePreview: inputTrace.preview,
      referenceImagePreview: referenceTrace.preview,
      contentSummary: summarizeContent(content),
    });

    const systemPrompt = {
      type: "text",
      text: `VOCÊ É UM EDITOR DE IMAGENS PROFISSIONAL. SIGA ESTAS REGRAS:

IDENTIFICAÇÃO DA IMAGEM PRINCIPAL:
- A PRIMEIRA image_url é a FOTO PRINCIPAL (cenário base).
- Preserve a estrutura macro dessa imagem: ângulo de câmera, enquadramento, fundo, iluminação geral.
- Imagens subsequentes são referências de objetos.

PRESERVAÇÃO DO CENÁRIO:
- Mantenha ângulo de câmera, perspectiva e enquadramento geral.
- Não corte, recorte ou redimensione o canvas.
- Elementos NÃO mencionados pelo usuário devem permanecer como estão.

PRIORIDADE DE CONFLITO:
- Se houver conflito entre "preservar a cena" e "executar a instrução do usuário", a INSTRUÇÃO DO USUÁRIO tem prioridade absoluta.
- É PROIBIDO retornar imagem praticamente idêntica quando há pedido explícito de edição.

REGRAS DE SUBSTITUIÇÃO (quando o usuário pede para trocar/substituir):
1. IDENTIFIQUE o objeto alvo na cena.
2. REMOVA o objeto antigo e coloque o novo da referência na MESMA região espacial.
3. NÃO crie duplicação (ex: se havia 1 arco, resultado deve ter 1 arco).
4. NÃO traga objetos para o foreground sem instrução.

REGRAS DE TRANSFORMAÇÃO (quando o usuário pede para reduzir, aumentar, mover, reposicionar):
- EXECUTE a transformação solicitada. Se pediu "reduza pela metade", o objeto deve ficar visivelmente menor.
- Se pediu "mova para a direita", o objeto deve mudar de posição.
- Dimensões e posições NÃO são imutáveis — obedeça ao comando do usuário.

REGRAS DE ADIÇÃO (quando o usuário pede para adicionar):
- Insira o novo objeto respeitando perspectiva, escala e iluminação da cena.
- Não remova objetos existentes.

REGRA ANTI-DUPLICAÇÃO:
- Nunca adicione um segundo exemplar do mesmo tipo quando o pedido é de substituição.

REGRA DE CONTINUIDADE:
- NÃO reintroduza elementos que não estão visíveis na imagem atual.

MARCAÇÕES VISUAIS:
- Traços, círculos ou setas em VERMELHO são guias de localização. Remova-os no resultado.

RESULTADO:
- A imagem final deve parecer foto real, coerente e sem artefatos visíveis.
- Mantenha qualidade e resolução equivalentes à imagem original.`,
    };

    const augmentedContent = [systemPrompt, ...content];

    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: "user",
          content: augmentedContent,
        },
      ],
    };

    console.log("[ReferenceEditDebug][edit-image] model-request", {
      timestamp: new Date().toISOString(),
      requestId: effectiveRequestId,
      operation: operation || "unspecified",
      model,
      payloadImageCount: imageUrls.length,
      payloadTextCount: content.filter((item) => item?.type === "text").length,
      payloadTextPreview: content
        .filter((item) => item?.type === "text")
        .map((item) => String(item.text || "").slice(0, 200)),
    });

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

    const outputTrace = imageTrace(imageUrl);

    console.log("[ReferenceEditDebug][edit-image] response", {
      timestamp: new Date().toISOString(),
      requestId: effectiveRequestId,
      operation: operation || "unspecified",
      model,
      inputImageHash: inputTrace.hash,
      outputImageHash: outputTrace.hash,
      outputImageLength: outputTrace.length,
      outputImagePreview: outputTrace.preview,
      hasTextResponse: Boolean(textResponse),
    });

    return new Response(
      JSON.stringify({
        imageUrl,
        text: textResponse,
        requestId: effectiveRequestId,
        debug: {
          model,
          inputImageHash: inputTrace.hash,
          outputImageHash: outputTrace.hash,
          outputImageLength: outputTrace.length,
          cacheUsed: false,
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("edit-image error:", e);
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
