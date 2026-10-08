// Offline stand-in for generic-baseline.v1: a deterministic "generic AI answer" to the brief.
export default function genericBaseline(_body, { text }) {
  const brief = text.match(/<brief>\n([\s\S]*)\n<\/brief>/)?.[1] ?? "";
  const words = brief.split(/\s+/).filter(Boolean).length;
  return {
    answer: `Generic baseline (stub, brief of ${words} words): automate omnichannel outreach with WhatsApp, SMS and email, clean the data, build a dashboard, and track conversion.`,
  };
}
