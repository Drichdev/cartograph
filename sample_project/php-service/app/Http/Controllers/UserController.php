<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\UserService;
use Illuminate\Support\Facades\Redis;

class UserController extends Controller
{
    public function __construct(private UserService $service)
    {
    }

    public function show(string $id)
    {
        $cached = Redis::get("user:" . $id);
        return $cached ?: $this->service->find($id);
    }

    public function store(string $name)
    {
        return $this->service->create($name);
    }

    public function destroy(string $id)
    {
        User::find($id)->delete();
    }
}
