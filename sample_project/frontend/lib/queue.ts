import { Queue, Worker } from "bullmq";
import { sendEmail } from "@/lib/email";

export const emailQueue = new Queue("email");

new Worker("email", async (job) => {
  await sendEmail(job.data);
});
