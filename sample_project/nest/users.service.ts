import { Inject, Injectable } from "@nestjs/common";
import { IUsersRepository, USERS_REPOSITORY } from "./users.repository.interface";

@Injectable()
export class UsersService {
  constructor(@Inject(USERS_REPOSITORY) private readonly repo: IUsersRepository) {}

  list() {
    return this.repo.findAll();
  }

  add(name: string) {
    return this.repo.create(name);
  }
}
