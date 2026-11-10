import { Module } from "@nestjs/common";
import { MongoUsersRepository } from "./users.repository";
import { USERS_REPOSITORY } from "./users.repository.interface";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService, { provide: USERS_REPOSITORY, useClass: MongoUsersRepository }],
})
export class UsersModule {}
