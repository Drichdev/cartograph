package com.acme.user.repository;

import com.acme.user.entity.UserEntity;
import org.springframework.stereotype.Repository;

@Repository
public class JpaUserRepository implements UserRepository {
    public String findName(String id) {
        return new UserEntity().getName();
    }

    public void save(String name) {
    }

    public void delete(String id) {
    }
}
