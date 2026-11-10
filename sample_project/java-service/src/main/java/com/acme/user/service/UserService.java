package com.acme.user.service;

import com.acme.user.repository.UserRepository;
import java.security.MessageDigest;
import java.sql.Statement;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class UserService {
    private final UserRepository repo;
    private final RedisTemplate<String, String> redis;
    private String adminPassword = "changeme123";

    public UserService(UserRepository repo, RedisTemplate<String, String> redis) {
        this.repo = repo;
        this.redis = redis;
    }

    public String find(String id) {
        String cached = redis.opsForValue().get("user:" + id);
        return cached != null ? cached : repo.findName(id);
    }

    public void add(String name) {
        repo.save(name);
    }

    public void remove(String id) {
        repo.delete(id);
    }

    public byte[] fingerprint(String s) throws Exception {
        return MessageDigest.getInstance("MD5").digest(s.getBytes());
    }

    public void search(Statement st, String name) throws Exception {
        st.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
    }

    public void neverUsed() {
    }
}
