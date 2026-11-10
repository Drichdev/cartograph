import { Injectable } from "@nestjs/common";
import { IUsersRepository } from "./users.repository.interface";

@Injectable()
export class MongoUsersRepository implements IUsersRepository {
  async findAll(): Promise<string[]> {
    return [];
  }

  async create(name: string): Promise<void> {
    return;
  }
}
