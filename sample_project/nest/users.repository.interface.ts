export interface IUsersRepository {
  findAll(): Promise<string[]>;
  create(name: string): Promise<void>;
}

export const USERS_REPOSITORY = "USERS_REPOSITORY";
