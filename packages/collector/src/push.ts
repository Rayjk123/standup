// Push to phone via ntfy. Only asks push — see high-level-design.md
// Component 5. Set NTFY_TOPIC to enable; unset means push is a no-op.

const NTFY_URL = process.env.NTFY_URL ?? "https://ntfy.sh";
const NTFY_TOPIC = process.env.NTFY_TOPIC;

export async function pushNotification(title: string, message: string): Promise<void> {
  if (!NTFY_TOPIC) return;

  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: "default",
      },
      body: message,
    });
  } catch (err) {
    console.error("[push] Failed to send notification:", err);
  }
}
