package com.acme.user.repository;

public interface UserRepository {
    String findName(String id);
    void save(String name);
    void delete(String id);
}
