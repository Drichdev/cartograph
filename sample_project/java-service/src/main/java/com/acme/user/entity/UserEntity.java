package com.acme.user.entity;

import javax.persistence.Entity;
import javax.persistence.Id;

@Entity
public class UserEntity {
    @Id
    private Long id;
    private String name;

    public String getName() {
        return name;
    }
}
