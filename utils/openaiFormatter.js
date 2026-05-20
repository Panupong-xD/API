import { randomUUID } from "crypto";

export function createOpenAIChatCompletion(model, result) {
  const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;

  return {
    id: `chatcmpl-${compactUuid()}`,
    object: "chat.completion",
    created: unixNow(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: hasToolCalls ? null : result.content ?? "",
          ...(hasToolCalls ? { tool_calls: result.toolCalls } : {})
        },
        finish_reason: hasToolCalls ? "tool_calls" : result.finishReason || "stop"
      }
    ],
    usage: emptyUsage()
  };
}

export function writeOpenAIChatStream(res, model, result, chunkSize) {
  const id = `chatcmpl-${compactUuid()}`;
  const created = unixNow();

  writeSseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null
      }
    ]
  });

  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
    writeToolCallStream(res, id, created, model, result.toolCalls, chunkSize);
    writeOpenAIStreamFinish(res, id, created, model, "tool_calls");
    res.write("data: [DONE]\n\n");
    return;
  }

  const text = result.content ?? "";
  for (let i = 0; i < text.length; i += chunkSize) {
    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: text.slice(i, i + chunkSize) },
          finish_reason: null
        }
      ]
    });
  }

  writeOpenAIStreamFinish(res, id, created, model, result.finishReason || "stop");
  res.write("data: [DONE]\n\n");
}

export function createResponsesObject(model, result) {
  const id = `resp_${compactUuid()}`;
  const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
  const output = hasToolCalls
    ? result.toolCalls.map((toolCall) => ({
      id: `fc_${compactUuid()}`,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments
    }))
    : [
      {
        id: `msg_${compactUuid()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: result.content ?? "",
            annotations: []
          }
        ]
      }
    ];

  return {
    id,
    object: "response",
    created_at: unixNow(),
    status: "completed",
    model,
    output,
    output_text: hasToolCalls ? "" : result.content ?? "",
    usage: emptyUsage()
  };
}

export function writeResponsesStream(res, model, result, chunkSize) {
  const response = createResponsesObject(model, result);

  writeSseEvent(res, "response.created", {
    ...response,
    output: [],
    output_text: ""
  });

  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
    result.toolCalls.forEach((toolCall, index) => {
      const item = {
        id: `fc_${compactUuid()}`,
        type: "function_call",
        status: "in_progress",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: ""
      };

      writeSseEvent(res, "response.output_item.added", {
        response_id: response.id,
        output_index: index,
        item
      });

      const args = toolCall.function.arguments || "{}";
      for (let i = 0; i < args.length; i += chunkSize) {
        writeSseEvent(res, "response.function_call_arguments.delta", {
          response_id: response.id,
          item_id: item.id,
          output_index: index,
          delta: args.slice(i, i + chunkSize)
        });
      }

      writeSseEvent(res, "response.function_call_arguments.done", {
        response_id: response.id,
        item_id: item.id,
        output_index: index,
        arguments: args
      });
    });
  } else {
    const text = result.content ?? "";
    for (let i = 0; i < text.length; i += chunkSize) {
      writeSseEvent(res, "response.output_text.delta", {
        response_id: response.id,
        delta: text.slice(i, i + chunkSize)
      });
    }

    writeSseEvent(res, "response.output_text.done", {
      response_id: response.id,
      text
    });
  }

  writeSseEvent(res, "response.completed", {
    response
  });
  res.write("data: [DONE]\n\n");
}

export function normalizeGeneratedImage(result) {
  let image = result?.image;

  if (!image && result?.meta?.image) {
    image = result.meta.image;
  }

  if (!image) {
    return null;
  }

  const text = String(image);
  if (/^[A-Za-z0-9+/=]+$/.test(text) && !text.startsWith("data:")) {
    return `data:image/png;base64,${text}`;
  }

  return text;
}

export function toOpenAIImageData(image, responseFormat = "url") {
  if (responseFormat === "b64_json" && image.startsWith("data:")) {
    return { b64_json: image.split(",")[1] || "" };
  }

  if (responseFormat === "b64_json" && /^[A-Za-z0-9+/=]+$/.test(image)) {
    return { b64_json: image };
  }

  return { url: image };
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function writeToolCallStream(res, id, created, model, toolCalls, chunkSize) {
  toolCalls.forEach((toolCall, index) => {
    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.function.name,
                  arguments: ""
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    });

    const args = toolCall.function.arguments || "{}";
    for (let i = 0; i < args.length; i += chunkSize) {
      writeSseData(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  function: {
                    arguments: args.slice(i, i + chunkSize)
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      });
    }
  });
}

function writeOpenAIStreamFinish(res, id, created, model, finishReason) {
  writeSseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason
      }
    ]
  });
}

function writeSseData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  writeSseData(res, payload);
}

function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };
}

function compactUuid() {
  return randomUUID().replace(/-/g, "");
}
