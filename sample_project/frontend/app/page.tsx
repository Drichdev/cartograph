import UserList from "@/components/UserList";
import { createUser } from "@/lib/api";

export default async function Home() {
  await createUser({ email: "a@x.fr", name: "A", password: "secret" });
  return <UserList emails={["a@x.fr"]} />;
}
