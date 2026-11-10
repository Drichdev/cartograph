package com.acme.user.controller;

import com.acme.user.service.UserService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/java-users")
public class UserController {
    private final UserService users;

    public UserController(UserService users) {
        this.users = users;
    }

    @GetMapping("/{id}")
    public String get(@PathVariable String id) {
        return users.find(id);
    }

    @PostMapping
    public void create(@RequestBody String name) {
        users.add(name);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public void remove(@PathVariable String id) {
        users.remove(id);
    }
}
