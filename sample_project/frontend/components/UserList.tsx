import { fetchUser } from "@/lib/api";
import { formatPrice } from "@/utils/format";

const API_KEY = "sk_live_abcdefghijklmnop123456";

export function UserBadge({ email }: { email: string }) {
  const load = async () => {
    const user = await fetchUser(email);
    return user.name;
  };
  return <span onClick={load} dangerouslySetInnerHTML={{ __html: email }} title={API_KEY} />;
}

export default function UserList({ emails }: { emails: string[] }) {
  return (
    <ul>
      {emails.map((e) => (
        <li key={e}>
          <UserBadge email={e} /> {formatPrice(10, "€")}
        </li>
      ))}
    </ul>
  );
}
