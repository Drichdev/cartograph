<?php

namespace App\Services;

use App\Jobs\SendWelcome;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class UserService
{
    private string $adminPassword = "changeme123";

    public function find(string $id)
    {
        return User::where('id', $id)->first();
    }

    public function create(string $name)
    {
        $user = User::create(['name' => $name]);
        SendWelcome::dispatch($user);
        Http::get('http://localhost:8000/users/1');
        return $user;
    }

    public function search(string $name)
    {
        return DB::select("SELECT * FROM users WHERE name = '" . $name . "'");
    }

    public function fingerprint(string $s)
    {
        return md5($s);
    }

    public function neverUsed()
    {
        return null;
    }
}
