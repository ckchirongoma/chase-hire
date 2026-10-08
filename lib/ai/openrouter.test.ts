import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiHttpError, AiOutputError, chatJson, embed, extractJson, transcribe } from "./openrouter";
import { chatReply, mockFetch, stubAiEnv, TEST_ENV } from "./test-utils";

const Schema = z.object({ name: z.string(), score: z.number() });

const baseOpts = {
  model: "test/requested-model",
  system: "You are a test.",
  user: "Hello",
  schema: Schema,
  promptVersion: "test-prompt.v1",
};

beforeEach(() => stubAiEnv());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("chatJson", () => {
  it("returns validated data, the reported model and the prompt version", async () => {
    const { requests } = mockFetch(chatReply('{"name":"Ada","score":4}', "provider/actual-model"));

    const res = await chatJson(baseOpts);

    expect(res).toEqual({
      data: { name: "Ada", score: 4 },
      model: "provider/actual-model",
      promptVersion: "test-prompt.v1",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${TEST_ENV.OPENROUTER_BASE_URL}/chat/completions`);
    expect(requests[0].headers.authorization).toBe(`Bearer ${TEST_ENV.OPENROUTER_API_KEY}`);
  });

  it("sends json_object response_format, data_collection deny, the model and the messages", async () => {
    const { requests } = mockFetch(chatReply('{"name":"Ada","score":4}'));

    await chatJson({ ...baseOpts, temperature: 0.3 });

    const body = requests[0].body;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toEqual({ data_collection: "deny" });
    expect(body.model).toBe("test/requested-model");
    expect(body.temperature).toBe(0.3);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "Hello" },
    ]);
  });

  it("falls back to the requested model when the response has none", async () => {
    mockFetch({ json: { choices: [{ message: { content: '{"name":"Ada","score":1}' } }] } });
    const res = await chatJson(baseOpts);
    expect(res.model).toBe("test/requested-model");
  });

  it("strips ```json fences", async () => {
    mockFetch(chatReply('```json\n{"name":"Ada","score":2}\n```'));
    const res = await chatJson(baseOpts);
    expect(res.data).toEqual({ name: "Ada", score: 2 });
  });

  it("retries once with the validation error when the first output is invalid", async () => {
    const { requests } = mockFetch(
      chatReply('{"name":"Ada","score":"high"}'),
      chatReply('{"name":"Ada","score":5}'),
    );

    const res = await chatJson(baseOpts);

    expect(res.data).toEqual({ name: "Ada", score: 5 });
    expect(requests).toHaveLength(2);
    const retryMessages = requests[1].body.messages!;
    const last = retryMessages[retryMessages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("score");
    expect(String(last.content)).toContain("Return only valid JSON matching the schema.");
    // The original conversation is kept.
    expect(retryMessages[0]).toEqual({ role: "system", content: "You are a test." });
  });

  it("retries once when the first output is not JSON at all", async () => {
    const { requests } = mockFetch(chatReply("Sure! Here you go."), chatReply('{"name":"B","score":3}'));
    const res = await chatJson(baseOpts);
    expect(res.data.name).toBe("B");
    const last = requests[1].body.messages!.at(-1)!;
    expect(String(last.content)).toContain("not valid JSON");
  });

  it("throws AiOutputError carrying the raw output after two invalid outputs", async () => {
    const { requests } = mockFetch(chatReply("not json"), chatReply('{"name":42}'));

    const err = await chatJson(baseOpts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiOutputError);
    expect((err as AiOutputError).raw).toBe('{"name":42}');
    expect(requests).toHaveLength(2);
  });

  it("sends files as OpenRouter file content parts", async () => {
    const { requests } = mockFetch(chatReply('{"name":"Ada","score":4}'));

    await chatJson({
      ...baseOpts,
      user: "Extract this.",
      files: [{ filename: "cv.pdf", mime: "application/pdf", base64: "JVBERi0xLjQ=" }],
    });

    expect(requests[0].body.messages![1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Extract this." },
        {
          type: "file",
          file: { filename: "cv.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQ=" },
        },
      ],
    });
  });

  it("throws AiHttpError without retrying on a 4xx", async () => {
    const { requests } = mockFetch({ status: 401, text: '{"error":"bad key"}' });

    const err = await chatJson(baseOpts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiHttpError);
    expect((err as AiHttpError).status).toBe(401);
    expect(requests).toHaveLength(1);
  });

  it("retries a 429/5xx once after a short delay", async () => {
    vi.useFakeTimers();
    const { requests } = mockFetch({ status: 503, text: "busy" }, chatReply('{"name":"Ada","score":4}'));

    const pending = chatJson(baseOpts);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;

    expect(res.data.score).toBe(4);
    expect(requests).toHaveLength(2);
  });

  it("gives up after a second 5xx", async () => {
    vi.useFakeTimers();
    const { requests } = mockFetch({ status: 502, text: "bad gateway" });

    const pending = chatJson(baseOpts).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1500);
    const err = await pending;

    expect(err).toBeInstanceOf(AiHttpError);
    expect((err as AiHttpError).status).toBe(502);
    expect(requests).toHaveLength(2);
  });

  it("treats an error object inside a 200 body as an HTTP error", async () => {
    mockFetch({ json: { error: { code: 400, message: "context too long" } } });
    const err = await chatJson(baseOpts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiHttpError);
    expect((err as AiHttpError).status).toBe(400);
  });
});

describe("extractJson", () => {
  it("parses JSON wrapped in prose", () => {
    expect(extractJson('Here it is: {"a":1} hope that helps')).toEqual({ a: 1 });
  });
});

describe("embed", () => {
  it("returns the embedding vector and sends model, input and dimensions", async () => {
    const vector = [0.1, 0.2, 0.3, 0.4];
    const { requests } = mockFetch({ json: { data: [{ embedding: vector }], model: "test/embed-model" } });

    const res = await embed("some cv text", { model: "test/embed-model", dimensions: 4 });

    expect(res).toEqual(vector);
    expect(requests[0].url).toBe(`${TEST_ENV.OPENROUTER_BASE_URL}/embeddings`);
    expect(requests[0].body).toMatchObject({ model: "test/embed-model", input: "some cv text", dimensions: 4 });
  });

  it("rejects a vector of the wrong dimension", async () => {
    mockFetch({ json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
    await expect(embed("text", { model: "m", dimensions: 1536 })).rejects.toBeInstanceOf(AiOutputError);
  });
});

describe("transcribe", () => {
  it("posts base64 audio with its format and the transcription prompt-version header", async () => {
    const { requests } = mockFetch({ json: { text: "I built the pipeline in 2023.", model: "openai/whisper-1" } });
    const audio = Buffer.from("fake-webm-bytes");

    const res = await transcribe(audio, { model: "test/stt", format: "webm", language: "en" });

    expect(res).toEqual({ text: "I built the pipeline in 2023.", model: "openai/whisper-1" });
    expect(requests[0].url).toBe(`${TEST_ENV.OPENROUTER_BASE_URL}/audio/transcriptions`);
    expect(requests[0].headers["x-prompt-version"]).toBe("transcription");
    expect(requests[0].body).toMatchObject({ model: "test/stt", language: "en", input_audio: { data: audio.toString("base64"), format: "webm" } });
  });

  it("falls back to the requested model and rejects a response without text", async () => {
    mockFetch({ json: { text: "" } });
    expect(await transcribe(Buffer.from("x"), { model: "test/stt", format: "ogg" })).toEqual({ text: "", model: "test/stt" });

    mockFetch({ json: { model: "x" } });
    await expect(transcribe(Buffer.from("x"), { model: "test/stt", format: "ogg" })).rejects.toBeInstanceOf(AiOutputError);
  });
});
