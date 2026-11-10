package com.acme.user

import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/kt-users")
class UserController(private val service: UserService) {

    @GetMapping("/{id}")
    fun get(@PathVariable id: String): String = service.find(id)

    @PostMapping
    fun create(@RequestBody name: String) {
        service.add(name)
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    fun remove(@PathVariable id: String) {
        service.remove(id)
    }
}
