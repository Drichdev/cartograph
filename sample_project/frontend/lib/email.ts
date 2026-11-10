export async function sendEmail(payload: { to: string; subject: string }) {
  return fetch("https://api.mailer.example/send", { method: "POST", body: JSON.stringify(payload) });
}
