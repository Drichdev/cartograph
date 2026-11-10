const API = process.env.NEXT_PUBLIC_API_URL;

export async function fetchUser(email: string) {
  const res = await fetch(`${API}/users/${email}`);
  return res.json();
}

export async function createUser(data: { email: string; name: string; password: string }) {
  return fetch(`${API}/users/`, { method: "POST", body: JSON.stringify(data) });
}

export function unusedApiHelper() {
  return "jamais appelée";
}
