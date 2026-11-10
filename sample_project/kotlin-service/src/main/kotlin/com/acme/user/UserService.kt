package com.acme.user

import org.springframework.data.redis.core.RedisTemplate
import org.springframework.stereotype.Service
import java.security.MessageDigest

@Service
class UserService(private val repo: UserRepository, private val redis: RedisTemplate<String, String>) {
    private val adminPassword = "changeme123"

    fun find(id: String): String {
        val cached = redis.opsForValue().get("u:" + id)
        return cached ?: repo.findName(id)
    }

    fun add(name: String) {
        repo.save(name)
    }

    fun remove(id: String) {
        repo.delete(id)
    }

    fun fingerprint(s: String): ByteArray = MessageDigest.getInstance("MD5").digest(s.toByteArray())

    fun neverUsed() {
    }
}
