import { prisma } from "@/lib/prisma";
import { redis, cached } from "@/lib/redis";
import { emailQueue } from "@/lib/queue";

export async function POST(req: Request) {
  const body = await req.json();
  const order = await prisma.order.create({ data: body });
  await emailQueue.add("receipt", { orderId: order.id });
  await redis.del("orders");
  return Response.json(order);
}

export async function GET() {
  const orders = await cached("orders", () => prisma.order.findMany());
  return Response.json(orders);
}
