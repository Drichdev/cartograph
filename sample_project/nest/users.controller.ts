import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { UsersService } from "./users.service";

@Controller("nest-users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  all() {
    return this.users.list();
  }

  @Post()
  @UseGuards(AuthGuard)
  create(@Body() dto: { name: string }) {
    return this.users.add(dto.name);
  }
}
