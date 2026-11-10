package com.acme.user

interface UserRepository {
    fun findName(id: String): String
    fun save(name: String)
    fun delete(id: String)
}

class InMemoryUserRepository : UserRepository {
    private val data = mutableMapOf<String, String>()
    override fun findName(id: String): String = data[id] ?: ""
    override fun save(name: String) { data[name] = name }
    override fun delete(id: String) { data.remove(id) }
}
