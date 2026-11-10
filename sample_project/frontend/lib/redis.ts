import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL!);

export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await redis.set(key, JSON.stringify(value), "EX", 60);
  return value;
}
